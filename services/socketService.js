// services/socketService.js

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");

const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");
const historyService = require("./historyService");

const { STATUSES } = require("./constants");

function init(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ["websocket"], // WebSocket only — no HTTP polling overhead
    allowUpgrades: false,       // Don't fall back to polling
    perMessageDeflate: true,    // Compress WebSocket frames
    maxHttpBufferSize: 1e6,     // 1MB max per message
  });

  ioInstance.setIo(io);

  // Ensure WS connection is established to Upstox
  upstoxService.connect().catch((e) => {
    console.error("❌ Upstox WS initial connect error:", e.message);
  });

  // Client auth
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

    // ── Parallel DB + Redis queries (was sequential) ──
    const [watchlist, alerts, existingStocks] = await Promise.all([
      Watchlist.findOne({ user: userId }).lean(),
      Alert.find({
        user: userId,
        status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
      }).lean(),
      redisService.getUserStocks(userId),
    ]);

    // Collect all unique symbols this user needs
    const subscribed = new Set(existingStocks);
    const allSymbols = new Set(existingStocks);

    // Add watchlist symbols
    if (watchlist?.symbols) {
      for (const item of watchlist.symbols) {
        allSymbols.add(item.instrument_key);
      }
    }

    // Add alert symbols
    if (alerts.length) {
      for (const alert of alerts) {
        allSymbols.add(alert.instrument_key);
      }
    }

    // Join all rooms at once
    for (const symbol of allSymbols) {
      socket.join(symbol);
    }

    // Determine which symbols need Redis registration
    const newSymbols = [];
    for (const symbol of allSymbols) {
      if (!subscribed.has(symbol)) {
        newSymbols.push(symbol);
      }
    }

    // Batch register new symbols in Redis
    if (newSymbols.length) {
      await Promise.all(
        newSymbols.map((symbol) => redisService.addUserToStock(userId, symbol))
      );

      // Check which newly added symbols need Upstox subscription
      const toSubscribe = [];
      for (const symbol of newSymbols) {
        if ((await redisService.getStockUserCount(symbol)) === 1) {
          toSubscribe.push(symbol);
        }
      }
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

    // Historical data on demand
    socket.on("request-history", async ({ instrumentKey, interval }) => {
      const roomName = `history:${instrumentKey}:${interval}`;
      try {
        socket.join(roomName);
        const candles = await historyService.cacheHistoricalData(
          instrumentKey,
          interval
        );
        socket.emit("history-data", {
          instrumentKey,
          interval,
          candles,
          timestamp: Date.now(),
          cached: true,
        });
      } catch (err) {
        console.error(`❌ History error:`, err.message);
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
      const roomName = `history:${instrumentKey}:${interval}`;
      socket.leave(roomName);
    });

    // Add stock subscription on demand
    socket.on("addStock", async (symbol) => {
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        allSymbols.add(symbol);
        await redisService.addUserToStock(userId, symbol);

        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);

          if (!(await redisService.getLastTick(symbol))) {
            try {
              const lastClose = await upstoxService.fetchLastClose(symbol);
              if (lastClose) {
                await redisService.setLastTick(symbol, {
                  fullFeed: { marketFF: { ltpc: { ltp: lastClose.close } } },
                });
              }
            } catch (e) {
              console.warn(
                `⚠️ Unable to fetch last close for ${symbol}:`,
                e.message
              );
            }
          }
        }
      }
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) {
        socket.emit("tick", { symbol, tick: lastTick });
      }
    });

    socket.on("removeStock", async (symbol) => {
      if (subscribed.has(symbol)) {
        subscribed.delete(symbol);
        await redisService.removeUserFromStock(userId, symbol);

        // Only unsubscribe from Upstox if no users AND no active alerts
        if (!(await redisService.shouldSubscribe(symbol))) {
          upstoxService.unsubscribe([symbol]);
          await redisService.removeStockFromGlobal(symbol);
        }
      }
      socket.leave(symbol);
    });

    // Client-originated tick (e.g. replay/testing)
    socket.on("tick", async ({ symbol, tick }) => {
      await redisService.setLastTick(symbol, tick);
      io.in(symbol).emit("tick", { symbol, tick });
    });

    socket.on("disconnect", async () => {
      socket.leave(`user:${userId}`);

      const remaining = await io.in(`user:${userId}`).fetchSockets();
      if (remaining.length === 0) {
        await redisService.cleanupUser(userId);
      }
    });
  });
}

module.exports = { init, STATUSES };
