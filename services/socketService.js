const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Watchlist = require("../models/Watchlist");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");

function init(server) {
  const io = new Server(server, { cors: { origin: "*" } });
  ioInstance.setIo(io); // ✅ Set first
  upstoxService.connect(); // ✅ Connect after IO is ready

  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
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

    const subscribed = new Set(
      await redisService.getUserStocks(socket.user.id)
    );

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

    socket.on("addStock", async (symbol) => {
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        await redisService.addUserToStock(socket.user.id, symbol);
        console.log(`📈 User ${socket.user.id} subscribed to ${symbol}`);
        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);
          console.log(`🌐 First global subscription to ${symbol}`);
        }
      }
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
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

    socket.on("disconnect", async () => {
      console.log(`❌ User disconnected: ${socket.user.id}`);
      socket.leave(`user:${socket.user.id}`);
      const rem = await io.in(`user:${socket.user.id}`).fetchSockets();
      if (rem.length === 0) {
        await redisService.cleanupUser(socket.user.id);
        console.log(`🧹 Cleaned up data for user: ${socket.user.id}`);
      }
    });
  });
}

module.exports = { init };
