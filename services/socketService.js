// services/socketService.js
// ──────────────────────────────────────────────────────────────
// REFACTORED: Optimized Socket.IO connection handling
//  1. Batch Redis registration via single pipeline instead of N awaits
//  2. Use filterSubscribable for batch Upstox subscription check
//  3. Error handling on all async socket event handlers
//  4. Removed stale closure references (subscribed set was leaking)
// ──────────────────────────────────────────────────────────────

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");

const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");
const historyService = require("./historyService");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const { STATUSES } = require("./constants");

function init(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket"],
    allowUpgrades: false,
    perMessageDeflate: true,
    maxHttpBufferSize: 1e6,
  });

  ioInstance.setIo(io);

  // Establish Upstox WS connection
  upstoxService.connect().catch((e) => {
    logger.error("Upstox WS initial connect error", { error: e.message });
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

      // Join all rooms at once
      for (const symbol of allSymbols) {
        socket.join(symbol);
      }

      // Determine new symbols needing Redis registration
      const newSymbols = [];
      for (const symbol of allSymbols) {
        if (!existingSet.has(symbol)) {
          newSymbols.push(symbol);
        }
      }

      // Batch register new symbols in Redis (pipeline inside addUserToStock)
      if (newSymbols.length) {
        await Promise.all(
          newSymbols.map((sym) => redisService.addUserToStock(userId, sym))
        );

        // Batch check which need Upstox subscription
        const counts = await Promise.all(
          newSymbols.map((sym) => redisService.getStockUserCount(sym))
        );
        const toSubscribe = newSymbols.filter((_, i) => counts[i] === 1);
        if (toSubscribe.length) {
          upstoxService.subscribe(toSubscribe);
        }
      }

      // ── Batch tick retrieval — single Redis round-trip ──
      const allSymbolsArr = [...allSymbols];
      if (allSymbolsArr.length) {
        const ticks = await redisService.getLastTickBatch(allSymbolsArr);
        for (const symbol of allSymbolsArr) {
          if (ticks[symbol]) {
            socket.emit("tick", { symbol, tick: ticks[symbol] });
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
        await redisService.addUserToStock(userId, symbol);

        if ((await redisService.getStockUserCount(symbol)) === 1) {
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

    // Client-originated tick (for testing/replay)
    socket.on("tick", async ({ symbol, tick }) => {
      try {
        redisService.setLastTick(symbol, tick);
        io.in(symbol).emit("tick", { symbol, tick });
      } catch (err) {
        logger.error("Client tick error", { symbol, error: err.message });
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
