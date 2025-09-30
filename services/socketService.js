const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");
const emailService = require("../utils/email");
const alertService = require("./alertService");
// Constants for statuses
const STATUSES = {
  PENDING: "pending",
  NEAR_ENTRY: "nearEntry",
  ENTER: "enter",
  RUNNING: "running",
  SL_HIT: "slHit",
  TARGET_HIT: "targetHit",
};

// Migration function (run once to reset old statuses)
async function migrateAlerts() {
  const alerts = await Alert.find({ status: { $nin: Object.values(STATUSES) } });
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    await alert.save();
  }
  console.log(`Migrated ${alerts.length} alerts to pending.`);
}

// Reusable helper functions for status checks
function isCrossToRunning(alert, previous, ltp) {
  return previous <= alert.entry_price && ltp > alert.entry_price;
}

function isSlHit(alert, ltp) {
  return ltp < alert.stop_loss;
}

function isTargetHit(alert, ltp) {
  return ltp > alert.target_price;
}

function isEnterCondition(alert, ltp) {
  return alert.entry_price > ltp && ltp > alert.stop_loss;
}

function isNearEntry(alert, ltp) {
  return Math.abs(ltp - alert.entry_price) / alert.entry_price <= 0.02;
}

function init(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  ioInstance.setIo(io);
  upstoxService.connect();

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

    // REMOVED: The following loop calling updateAlertStatus
    // Reason: Alert updates are now handled backend-side via queue in alertService.js
    // const userAlerts = await Alert.find({ user: socket.user.id });
    // for (const alert of userAlerts) {
    //   const lastTick = await redisService.getLastTick(alert.instrument_key);
    //   if (lastTick) {
    //     await alertService.updateAlertStatus(alert.instrument_key, lastTick, ioInstance.getIo());
    //   }
    // }

    const subscribed = new Set(await redisService.getUserStocks(socket.user.id));

    for (const symbol of subscribed) {
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
    }

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

    const alerts = await Alert.find({
      user: socket.user.id,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
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

    socket.on("addStock", async (symbol) => {
      if (!subscribed.has(symbol)) {
        subscribed.add(symbol);
        await redisService.addUserToStock(socket.user.id, symbol);
        console.log(`📈 User ${socket.user.id} subscribed to ${symbol}`);

        if ((await redisService.getStockUserCount(symbol)) === 1) {
          upstoxService.subscribe([symbol]);
          console.log(`🌐 First global subscription to ${symbol}`);

          if (!(await redisService.getLastTick(symbol))) {
            const lastClose = await upstoxService.fetchLastClose(symbol);
            if (lastClose) {
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

    socket.on("tick", async ({ symbol, tick }) => {
      await redisService.setLastTick(symbol, tick);
      io.in(symbol).emit("tick", { symbol, tick });
      // No need for updateAlertStatus here; handled server-side in upstoxService.js
    });

    // NEW: Handle frontend reconnect notification
    socket.on("reconnect-request", () => {
      // Optional: Force resubscribe for this socket
      // Add logic if needed to re-send last ticks or re-join rooms
    });

    socket.on("disconnect", async () => {
      console.log(`❌ User disconnected: ${socket.user.id}`);
      socket.leave(`user:${socket.user.id}`);

      const remainingSockets = await io.in(`user:${socket.user.id}`).fetchSockets();
      if (remainingSockets.length === 0) {
        await redisService.cleanupUser(socket.user.id);
        console.log(`🧹 Cleaned up data for user: ${socket.user.id}`);
      }
    });
  });
}

async function getStockUsers(symbol) {
  return await redis.smembers(`stock:${symbol}:users`);
}

module.exports = {
  init,
  migrateAlerts: alertService.migrateAlerts,
  STATUSES: alertService.STATUSES
};
