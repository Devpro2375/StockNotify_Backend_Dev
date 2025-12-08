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
    cors: { origin: "*" }, // Keep permissive to avoid WS issues behind proxies; HTTP CORS handles rest
    pingTimeout: 60000,
    pingInterval: 25000,
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
    console.log(`✅ User connected: ${socket.user.id}`);
    socket.join(`user:${socket.user.id}`);

    // Historical data on demand
    socket.on("request-history", async ({ instrumentKey, interval }) => {
      const roomName = `history:${instrumentKey}:${interval}`;
      console.log(
        `📊 User ${socket.user.id} requesting history: ${instrumentKey} ${interval}`
      );
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
        console.log(
          `✅ Sent ${candles.length} candles to user ${socket.user.id}`
        );
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
      console.log(`📉 User ${socket.user.id} left history room ${roomName}`);
    });

    // Subscribe user to existing stocks
    const subscribed = new Set(
      await redisService.getUserStocks(socket.user.id)
    );

    for (const symbol of subscribed) {
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
    }

    // Ensure watchlist symbols are tracked
    const watchlist = await Watchlist.findOne({ user: socket.user.id });
    if (watchlist?.symbols) {
      for (const item of watchlist.symbols) {
        const symbol = item.instrument_key;
        if (!subscribed.has(symbol)) {
          subscribed.add(symbol);
          await redisService.addUserToStock(socket.user.id, symbol);
          if ((await redisService.getStockUserCount(symbol)) === 1) {
            upstoxService.subscribe([symbol]);
            console.log(`🌐 First global subscription to ${symbol}`);
          }
        }
        socket.join(symbol);
        const lastTick = await redisService.getLastTick(symbol);
        if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
      }
    }

    // Ensure alert-related symbols are tracked
    const alerts = await Alert.find({
      user: socket.user.id,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });
    const alertedSymbols = new Set(alerts.map((a) => a.instrument_key));

    for (const symbol of alertedSymbols) {
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        await redisService.addUserToStock(socket.user.id, symbol);
        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);
          console.log(`🌐 First global subscription to ${symbol} for alerts`);
        }
      }
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
    }

    // Add stock subscription on demand
    socket.on("addStock", async (symbol) => {
      console.log(`📈 User ${socket.user.id} requesting addStock: ${symbol}`);
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        await redisService.addUserToStock(socket.user.id, symbol);
        console.log(`✅ User ${socket.user.id} subscribed to ${symbol}`);

        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);
          console.log(`🌐 First global subscription to ${symbol}`);

          if (!(await redisService.getLastTick(symbol))) {
            try {
              const lastClose = await require("./upstoxService").fetchLastClose(
                symbol
              );
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
        console.log(
          `📤 Sending last tick to user ${socket.user.id} for ${symbol}`
        );
        socket.emit("tick", { symbol, tick: lastTick });
      }
    });

    socket.on("removeStock", async (symbol) => {
      if (subscribed.has(symbol)) {
        subscribed.delete(symbol);
        await redisService.removeUserFromStock(socket.user.id, symbol);
        console.log(`📉 User ${socket.user.id} unsubscribed from ${symbol}`);

        if ((await redisService.getStockUserCount(symbol)) === 0) {
          upstoxService.unsubscribe([symbol]);
          await redisService.removeStockFromGlobal(symbol);
          console.log(`❎ Last global unsubscription from ${symbol}`);
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
      console.log(`❌ User disconnected: ${socket.user.id}`);
      socket.leave(`user:${socket.user.id}`);

      const remaining = await io.in(`user:${socket.user.id}`).fetchSockets();
      if (remaining.length === 0) {
        await redisService.cleanupUser(socket.user.id);
        console.log(`🧹 Cleaned up data for user: ${socket.user.id}`);
      }
    });
  });
}

module.exports = { init, STATUSES };
