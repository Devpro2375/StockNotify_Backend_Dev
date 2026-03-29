// services/socketService.js
// ──────────────────────────────────────────────────────────────
// REFACTORED: Optimized Socket.IO connection handling
//  1. Batch Redis registration via single pipeline instead of N awaits
//  2. Use filterSubscribable for batch Upstox subscription check
//  3. Error handling on all async socket event handlers
//  4. Removed stale closure references (subscribed set was leaking)
// ──────────────────────────────────────────────────────────────

const { Server } = require("socket.io");
const { createAdapter } = require("@socket.io/redis-adapter");
const Redis = require("ioredis");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const redisConfig = require("../config/redisConfig");

const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");
const historyService = require("./historyService");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const { STATUSES } = require("./constants");

// ── Connection rate limiter ──
// Prevents clients from hammering the server with rapid reconnects
const connectionTimestamps = new Map(); // ip -> [timestamps]
const RATE_LIMIT_WINDOW = 10000; // 10 seconds
const RATE_LIMIT_MAX = 5; // max connections per window per IP

// Periodically prune stale IP entries (every 60s)
const _rateLimitCleanup = setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW;
  for (const [ip, stamps] of connectionTimestamps) {
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    if (!stamps.length) connectionTimestamps.delete(ip);
  }
}, 60000);
_rateLimitCleanup.unref();

function init(server) {
  const io = new Server(server, {
    cors: {
      origin: (process.env.ALLOWED_ORIGINS || process.env.FRONTEND_BASE_URL || "http://localhost:3000")
        .split(",")
        .map((s) => s.trim()),
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket"],
    allowUpgrades: false,
    perMessageDeflate: true,
    maxHttpBufferSize: 1e6,
  });

  // Wire up Redis adapter for horizontal scaling (pub/sub across multiple instances)
  try {
    const pubClient = new Redis(redisConfig);
    const subClient = new Redis(redisConfig);
    pubClient.on("error", (err) => logger.warn("Redis adapter pub error", { error: err.message }));
    subClient.on("error", (err) => logger.warn("Redis adapter sub error", { error: err.message }));
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Socket.IO Redis adapter attached");
  } catch (adapterErr) {
    logger.warn("Socket.IO Redis adapter failed — running without it (single-instance mode)", {
      error: adapterErr.message,
    });
  }

  ioInstance.setIo(io);

  // Establish Upstox WS connection
  upstoxService.connect().catch((e) => {
    logger.error("Upstox WS initial connect error", { error: e.message });
  });

  // Connection rate-limit middleware
  io.use((socket, next) => {
    const ip = socket.handshake.address;
    const now = Date.now();
    let stamps = connectionTimestamps.get(ip);
    if (!stamps) {
      stamps = [];
      connectionTimestamps.set(ip, stamps);
    }
    // Evict timestamps outside window
    while (stamps.length && stamps[0] < now - RATE_LIMIT_WINDOW) stamps.shift();
    if (stamps.length >= RATE_LIMIT_MAX) {
      return next(new Error("Rate limit exceeded"));
    }
    stamps.push(now);
    next();
  });

  // Client auth middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("Authentication error"));
    try {
      socket.user = jwt.verify(token, config.jwtSecret).user;
      next();
    } catch {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", async (socket) => {
    const userId = socket.user.id;
    socket.join(`user:${userId}`);
    metrics.inc("socket_connections");

    try {
      // ── Parallel DB + Redis queries ──
      const [watchlist, alerts, existingStocks] = await Promise.all([
        Watchlist.findOne({ user: userId }).lean(),
        Alert.find({
          user: userId,
          status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
        }).lean(),
        redisService.getUserStocks(userId),
      ]);

      // Collect all unique symbols
      const existingSet = new Set(existingStocks);
      const allSymbols = new Set(existingStocks);

      if (watchlist?.symbols) {
        for (const item of watchlist.symbols) {
          allSymbols.add(item.instrument_key);
        }
      }
      if (alerts.length) {
        for (const alert of alerts) {
          allSymbols.add(alert.instrument_key);
        }
      }

      // Join all rooms in a single call (Socket.IO accepts an array)
      const allSymbolsArr = [...allSymbols];
      if (allSymbolsArr.length) {
        socket.join(allSymbolsArr);
      }

      // Determine new symbols needing Redis registration
      const newSymbols = [];
      for (const symbol of allSymbols) {
        if (!existingSet.has(symbol)) {
          newSymbols.push(symbol);
        }
      }

      // Batch register new symbols in Redis — single pipeline for all adds
      if (newSymbols.length) {
        await redisService.addUserToStockBatch(userId, newSymbols);

        // Batch check which need Upstox subscription — single pipeline
        const counts = await redisService.getStockUserCountBatch(newSymbols);
        const toSubscribe = newSymbols.filter((_, i) => counts[i] === 1);
        if (toSubscribe.length) {
          upstoxService.subscribe(toSubscribe);
        }
      }

      // ── Batch tick retrieval — single Redis round-trip ──
      // (allSymbolsArr already defined above from room join)
      if (allSymbolsArr.length) {
        const ticks = await redisService.getLastTickBatch(allSymbolsArr);
        for (const symbol of allSymbolsArr) {
          if (ticks[symbol]) {
            // volatile: initial catch-up ticks are droppable under backpressure
            socket.volatile.emit("tick", { symbol, tick: ticks[symbol] });
          }
        }
      }
    } catch (err) {
      logger.error("Socket connection setup error", { userId, error: err.message });
    }

    // Historical data on demand
    socket.on("request-history", async ({ instrumentKey, interval }) => {
      const roomName = `history:${instrumentKey}:${interval}`;
      try {
        socket.join(roomName);
        const candles = await historyService.cacheHistoricalData(instrumentKey, interval);
        socket.emit("history-data", {
          instrumentKey,
          interval,
          candles,
          timestamp: Date.now(),
          cached: true,
        });
      } catch (err) {
        logger.error("History error", { instrumentKey, error: err.message });
        socket.emit("history-error", {
          instrumentKey,
          interval,
          error: err.message,
          status: err.status || err.response?.status || null,
          code: err.code || err.response?.data?.code || null,
        });
      }
    });

    socket.on("leave-history", ({ instrumentKey, interval }) => {
      socket.leave(`history:${instrumentKey}:${interval}`);
    });

    // Add stock subscription on demand
    socket.on("addStock", async (symbol) => {
      try {
        socket.join(symbol);

        // NOTE: addUserToStock (SADD pipeline) and getStockUserCount (SCARD) are two
        // separate Redis round-trips. In a multi-instance setup the Redis adapter
        // keeps rooms in sync but there is a narrow window where two simultaneous
        // addStock calls for the same symbol could both read count===1 and both
        // call subscribe(). This is safe (Upstox ignores duplicate subs) but the
        // true fix would be a Lua script doing SADD+SCARD atomically in redisService.
        await redisService.addUserToStock(userId, symbol);
        const userCount = await redisService.getStockUserCount(symbol);

        if (userCount === 1) {
          upstoxService.subscribe([symbol]);

          if (!(await redisService.getLastTick(symbol))) {
            try {
              const lastClose = await upstoxService.fetchLastClose(symbol);
              if (lastClose) {
                redisService.setLastTick(symbol, {
                  fullFeed: { marketFF: { ltpc: { ltp: lastClose.close } } },
                });
              }
            } catch (e) {
              logger.warn(`Unable to fetch last close for ${symbol}`, { error: e.message });
            }
          }
        }

        const lastTick = await redisService.getLastTick(symbol);
        if (lastTick) {
          socket.emit("tick", { symbol, tick: lastTick });
        }
      } catch (err) {
        logger.error("addStock error", { symbol, error: err.message });
      }
    });

    socket.on("removeStock", async (symbol) => {
      try {
        socket.leave(symbol);
        await redisService.removeUserFromStock(userId, symbol);

        if (!(await redisService.shouldSubscribe(symbol))) {
          upstoxService.unsubscribe([symbol]);
          await redisService.removeStockFromGlobal(symbol);
        }
      } catch (err) {
        logger.error("removeStock error", { symbol, error: err.message });
      }
    });

    socket.on("disconnect", async () => {
      metrics.inc("socket_disconnections");
      try {
        const remaining = await io.in(`user:${userId}`).fetchSockets();
        if (remaining.length === 0) {
          await redisService.cleanupUser(userId);
        }
      } catch (err) {
        logger.error("Disconnect cleanup error", { userId, error: err.message });
      }
    });
  });
}

module.exports = { init };
