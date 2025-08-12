const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");

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
  const alerts = await Alert.find({ status: { $nin: Object.values(STATUSES) } }); // Reset any invalid/old
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    await alert.save();
  }
  console.log(`Migrated ${alerts.length} alerts to pending.`);
}

// Reusable helper functions for status checks (based strictly on your rules)
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

// Updated function to update alert statuses based on tick (no bullish/bearish mirroring)
async function updateAlertStatus(symbol, tick) {
  const ltp = tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;
  if (!ltp) {
    console.log(`No LTP for ${symbol}, skipping update.`);
    return;
  }

  const userIds = await redisService.getStockUsers(symbol);
  console.log(`Updating statuses for ${symbol} with LTP ${ltp} for users: ${userIds.join(', ')}`);

  for (const userId of userIds) {
    const alerts = await Alert.find({
      user: userId,
      instrument_key: symbol,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }, // Skip terminal
    });
    for (const alert of alerts) {
      // Initialize previous with fallback to cmp if last_ltp is null
      const previous = alert.last_ltp ?? alert.cmp ?? (alert.stop_loss - 1); // Safe default below SL
      let newStatus = alert.status ?? STATUSES.PENDING;

      // Priority 1: Check for SL Hit (terminal)
      if (isSlHit(alert, ltp)) {
        newStatus = STATUSES.SL_HIT;
      }
      // Priority 2: Check for Target Hit (terminal, only after entry triggered)
      else if ([STATUSES.ENTER, STATUSES.RUNNING].includes(alert.status) && isTargetHit(alert, ltp)) {
        newStatus = STATUSES.TARGET_HIT;
      }
      // Priority 3: Check for Running (only if currently in "enter" and cross detected)
      else if (alert.status === STATUSES.ENTER && isCrossToRunning(alert, previous, ltp)) {
        newStatus = STATUSES.RUNNING;
        console.log(`Triggered running for alert ${alert._id}: Cross detected from ${previous} to ${ltp} after enter.`);
      }
      // Priority 4: Check for Enter
      else if (![STATUSES.RUNNING].includes(newStatus) && isEnterCondition(alert, ltp)) {
        newStatus = STATUSES.ENTER;
      }
      // Priority 5: Check for Near Entry (if not enter/running and entry not triggered)
      else if (![STATUSES.ENTER, STATUSES.RUNNING].includes(newStatus) && isNearEntry(alert, ltp)) {
        newStatus = STATUSES.NEAR_ENTRY;
      }
      // Fallback: Pending
      else {
        newStatus = STATUSES.PENDING;
      }

      // Only save if status changed or last_ltp needs update
      if (newStatus === alert.status && alert.last_ltp === ltp) continue;

      alert.status = newStatus;
      alert.last_ltp = ltp;
      await alert.save();
      console.log(`Updated alert ${alert._id} to status ${newStatus} at LTP ${ltp}.`);

      ioInstance.getIo().to(`user:${userId}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltp,
      });

      if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus)) {
        ioInstance.getIo().to(`user:${userId}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          price: ltp,
        });
      }
    }
  }
}

function init(server) {
  const io = new Server(server, { cors: { origin: "*" } });
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

    // Force initial status update for user's alerts
    const userAlerts = await Alert.find({ user: socket.user.id });
    for (const alert of userAlerts) {
      const lastTick = await redisService.getLastTick(alert.instrument_key);
      if (lastTick) {
        await updateAlertStatus(alert.instrument_key, lastTick);
      }
    }

    // Updated: Use Redis for faster subscribed stocks loading
    const subscribed = new Set(await redisService.getUserStocks(socket.user.id));

    // Join rooms and send last ticks
    for (const symbol of subscribed) {
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
    }

    // Subscribe to user's watchlist stocks (if not already in Redis)
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

    // Subscribe to user's alerted stocks
    const alerts = await Alert.find({ user: socket.user.id, status: { $ne: STATUSES.TARGET_HIT } });
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
      await updateAlertStatus(symbol, tick);
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

// In redisService.js (if not already present)
async function getStockUsers(symbol) {
  return await redis.smembers(`stock:${symbol}:users`);
}
