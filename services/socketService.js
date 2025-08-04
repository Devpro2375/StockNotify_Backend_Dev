// C:\Users\deves\Desktop\Upstox API Trials\Backend_Github\services\socketService.js

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert"); // Import Alert model for real-time triggering
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");

async function checkAlertTriggers(userId, symbol, tick) {
  const alerts = await Alert.find({
    user: userId,
    instrument_key: symbol,
    status: "active",
  });
  for (const alert of alerts) {
    const price =
      tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;
    if (!price) continue;

    let triggered = false;
    if (alert.trend === "bullish") {
      if (price >= alert.target_price) triggered = true; // Target hit
      else if (price <= alert.stop_loss) triggered = true; // SL hit
    } else if (alert.trend === "bearish") {
      if (price <= alert.target_price) triggered = true;
      else if (price >= alert.stop_loss) triggered = true;
    }

    if (triggered) {
      await Alert.updateOne({ _id: alert._id }, { status: "triggered" });
      ioInstance
        .getIo()
        .to(`user:${userId}`)
        .emit("alert_triggered", { alertId: alert._id, symbol, price });
    }
  }
}

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

    // Subscribe to user's watchlist stocks
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

    // Subscribe to user's alerted stocks (in addition to watchlist)
    const alerts = await Alert.find({ user: socket.user.id, status: "active" });
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

    socket.on("addStock", async (symbol) => {
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        await redisService.addUserToStock(socket.user.id, symbol);
        console.log(`📈 User ${socket.user.id} subscribed to ${symbol}`);
        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);
          console.log(`🌐 First global subscription to ${symbol}`);
          // New: Proactively fetch last close if no tick exists
          if (!(await redisService.getLastTick(symbol))) {
            const lastClose = await upstoxService.fetchLastClose(symbol);
            if (lastClose) {
              // Set as initial tick (simplified)
              await redisService.setLastTick(symbol, {
                fullFeed: { marketFF: { ltpc: { ltp: lastClose.close } } },
              });
            }
          }
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

    // On tick, check alerts first, then handle existing tick logic
    socket.on("tick", async ({ symbol, tick }) => {
      await checkAlertTriggers(socket.user.id, symbol, tick);
      // Existing tick handling (e.g., broadcast or store last tick)
      await redisService.setLastTick(symbol, tick);
      io.in(symbol).emit("tick", { symbol, tick });
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
