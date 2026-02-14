// services/alertService.js
// ──────────────────────────────────────────────────────────────
// High-performance alert processor with IN-MEMORY alert cache.
// Instead of querying MongoDB on every tick (~100-600 queries/sec),
// we load all active alerts into memory and refresh every 30s.
// MongoDB is only hit for:
//   1. Cache refresh (every 30s) — 1 query
//   2. bulkWrite status updates — only when alerts actually change
// ──────────────────────────────────────────────────────────────

const admin = require("./firebase");
const config = require("../config/config");

const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailQueue = require("../queues/emailQueue");
const telegramQueue = require("../queues/telegramQueue");
const alertQueue = require("../queues/alertQueue");
const ioInstance = require("./ioInstance");

const { STATUSES, TRADE_TYPES } = require("./constants");

// ───────────────────── LONG HELPERS ─────────────────────
function longSlHit(alert, ltp) {
  return ltp <= alert.stop_loss;
}
function longTargetHit(alert, ltp) {
  return ltp >= alert.target_price;
}
function longEnterCondition(alert, ltp) {
  return ltp < alert.entry_price && ltp > alert.stop_loss;
}
function longRunningCondition(alert, previous, ltp) {
  return previous < alert.entry_price && ltp >= alert.entry_price;
}
function longNearEntry(alert, ltp) {
  const diffPercent = ((ltp - alert.entry_price) / alert.entry_price) * 100;
  return ltp > alert.entry_price && diffPercent <= 1;
}
function longStillRunning(alert, ltp) {
  return (
    ltp >= alert.entry_price &&
    ltp < alert.target_price &&
    ltp > alert.stop_loss
  );
}

// ───────────────────── SHORT HELPERS ─────────────────────
function shortSlHit(alert, ltp) {
  return ltp >= alert.stop_loss;
}
function shortTargetHit(alert, ltp) {
  return ltp <= alert.target_price;
}
function shortEnterCondition(alert, ltp) {
  return ltp > alert.entry_price && ltp < alert.stop_loss;
}
function shortRunningCondition(alert, previous, ltp) {
  return previous > alert.entry_price && ltp <= alert.entry_price;
}
function shortNearEntry(alert, ltp) {
  const diffPercent = ((alert.entry_price - ltp) / alert.entry_price) * 100;
  return ltp < alert.entry_price && diffPercent <= 1;
}
function shortStillRunning(alert, ltp) {
  return ltp > alert.target_price && ltp < alert.stop_loss;
}

// ───────────────────── UNIFIED HELPERS ─────────────────────
function isSlHit(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortSlHit(alert, ltp)
    : longSlHit(alert, ltp);
}
function isTargetHit(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortTargetHit(alert, ltp)
    : longTargetHit(alert, ltp);
}
function isEnterCondition(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortEnterCondition(alert, ltp)
    : longEnterCondition(alert, ltp);
}
function isRunningCondition(alert, previous, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortRunningCondition(alert, previous, ltp)
    : longRunningCondition(alert, previous, ltp);
}
function isNearEntry(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortNearEntry(alert, ltp)
    : longNearEntry(alert, ltp);
}
function isStillRunning(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? shortStillRunning(alert, ltp)
    : longStillRunning(alert, ltp);
}

// ══════════════════════════════════════════════════════════
// IN-MEMORY ALERT CACHE
// ══════════════════════════════════════════════════════════
// Map<instrument_key, CachedAlert[]>
// Each CachedAlert is a plain object with alert data + user info.
// Refreshed every CACHE_REFRESH_MS from MongoDB.
// ══════════════════════════════════════════════════════════

const alertCache = new Map();     // instrument_key → CachedAlert[]
const CACHE_REFRESH_MS = 30_000;  // 30 seconds
let cacheRefreshTimer = null;
let cacheReady = false;
let isRefreshing = false;

/**
 * Load all active alerts + their users into memory.
 * Single MongoDB query with populate — runs every 30s.
 */
async function refreshAlertCache() {
  if (isRefreshing) return;
  isRefreshing = true;

  try {
    const alerts = await Alert.find({
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    }).populate("user").lean();

    // Group by instrument_key
    const newCache = new Map();
    for (const alert of alerts) {
      if (!alert.user || !alert.user.email) continue;
      const key = alert.instrument_key;
      if (!newCache.has(key)) {
        newCache.set(key, []);
      }
      newCache.get(key).push(alert);
    }

    // Atomic swap
    alertCache.clear();
    for (const [key, value] of newCache) {
      alertCache.set(key, value);
    }

    if (!cacheReady) {
      console.log(
        `✅ Alert cache initialized: ${alerts.length} alerts across ${newCache.size} stocks`
      );
      cacheReady = true;
    }
  } catch (err) {
    console.error("❌ Alert cache refresh error:", err.message);
  } finally {
    isRefreshing = false;
  }
}

/**
 * Start the cache refresh loop. Call once on boot.
 */
function startCacheRefresh() {
  // Initial load
  refreshAlertCache();
  // Periodic refresh
  cacheRefreshTimer = setInterval(refreshAlertCache, CACHE_REFRESH_MS);
}

/**
 * Stop the cache refresh (for shutdown).
 */
function stopCacheRefresh() {
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
  }
}

/**
 * Update a single alert in the cache after a status change.
 * This keeps the cache consistent between full refreshes.
 */
function updateCacheEntry(alertId, updates) {
  for (const [, alerts] of alertCache) {
    for (let i = 0; i < alerts.length; i++) {
      if (alerts[i]._id.toString() === alertId.toString()) {
        Object.assign(alerts[i], updates);

        // If terminal status, remove from cache
        if (
          updates.status === STATUSES.SL_HIT ||
          updates.status === STATUSES.TARGET_HIT
        ) {
          alerts.splice(i, 1);
        }
        return;
      }
    }
  }
}

// ── LTP dedup cache ──
// Skips alert processing when LTP hasn't changed for a symbol.
const lastProcessedLtp = new Map();
const MAX_LTP_CACHE = 10000;

// ── Notification trigger statuses ──
const EMAIL_TRIGGER_STATUSES = new Set([
  STATUSES.SL_HIT,
  STATUSES.TARGET_HIT,
  STATUSES.ENTER,
]);

// ═══════════════════════════════════════════════════════
// QUEUE PROCESSOR — reads from in-memory cache, NOT MongoDB
// ═══════════════════════════════════════════════════════
alertQueue.process(async (job) => {
  const { symbol, tick } = job.data;

  const ltp =
    tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;

  const ltpNum = typeof ltp === "number" ? ltp : Number(ltp);
  if (!ltpNum || Number.isNaN(ltpNum)) return;

  // Skip if LTP unchanged since last processing for this symbol
  if (lastProcessedLtp.get(symbol) === ltpNum) return;
  lastProcessedLtp.set(symbol, ltpNum);

  // Prevent unbounded memory growth
  if (lastProcessedLtp.size > MAX_LTP_CACHE) {
    lastProcessedLtp.clear();
  }

  // ── READ FROM IN-MEMORY CACHE (zero DB queries!) ──
  const alerts = alertCache.get(symbol);
  if (!alerts || !alerts.length) return;

  const bulkOps = [];
  const io = ioInstance.getIo();

  for (const alert of alerts) {
    const user = alert.user;
    if (!user || !user.email) continue;

    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    let newStatus = alert.status ?? STATUSES.PENDING;
    const oldStatus = alert.status;
    let entryCrossedUpdated = Boolean(alert.entry_crossed);

    // ───────────────── STATE MACHINE ─────────────────
    if (isSlHit(alert, ltpNum)) {
      newStatus = STATUSES.SL_HIT;
    } else if (isTargetHit(alert, ltpNum) && entryCrossedUpdated) {
      newStatus = STATUSES.TARGET_HIT;
    } else {
      if (isEnterCondition(alert, ltpNum) && !entryCrossedUpdated) {
        newStatus = STATUSES.ENTER;
        entryCrossedUpdated = true;
      } else if (
        entryCrossedUpdated &&
        isRunningCondition(alert, previous, ltpNum)
      ) {
        newStatus = STATUSES.RUNNING;
      } else if (
        (oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) &&
        entryCrossedUpdated
      ) {
        if (isStillRunning(alert, ltpNum)) {
          newStatus = STATUSES.RUNNING;
        } else if (isEnterCondition(alert, ltpNum)) {
          newStatus = STATUSES.RUNNING;
        } else {
          newStatus = oldStatus;
        }
      } else if (isNearEntry(alert, ltpNum) && !entryCrossedUpdated) {
        newStatus = STATUSES.NEAR_ENTRY;
      } else {
        newStatus = STATUSES.PENDING;
      }
    }

    // Skip if nothing changed
    if (
      newStatus === alert.status &&
      alert.last_ltp === ltpNum &&
      entryCrossedUpdated === alert.entry_crossed
    ) {
      continue;
    }

    // ── Update in-memory cache immediately (no wait for DB) ──
    updateCacheEntry(alert._id, {
      status: newStatus,
      last_ltp: ltpNum,
      entry_crossed: entryCrossedUpdated,
    });

    // Collect bulk DB update
    bulkOps.push({
      updateOne: {
        filter: { _id: alert._id },
        update: {
          $set: {
            status: newStatus,
            last_ltp: ltpNum,
            entry_crossed: entryCrossedUpdated,
          },
        },
      },
    });

    if (newStatus !== oldStatus) {
      console.log(
        `📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltpNum}`
      );
    }

    // ───────────────── NOTIFICATIONS ─────────────────
    if (EMAIL_TRIGGER_STATUSES.has(newStatus) && newStatus !== oldStatus) {
      const alertDetails = {
        trading_symbol: alert.trading_symbol,
        status: newStatus,
        current_price: ltpNum,
        entry_price: alert.entry_price,
        stop_loss: alert.stop_loss,
        target_price: alert.target_price,
        position: alert.position,
        trade_type: alert.trade_type,
        level: alert.level,
        triggered_at: new Date(),
      };

      const notifPriority =
        newStatus === STATUSES.SL_HIT || newStatus === STATUSES.TARGET_HIT
          ? 1
          : 2;

      // Email — fire and forget
      emailQueue
        .add(
          { userEmail: user.email, alertDetails },
          { priority: notifPriority, removeOnComplete: true, removeOnFail: false }
        )
        .catch((err) =>
          console.error(`❌ Email queue error for ${alert._id}:`, err.message)
        );

      // Firebase Push
      if (user.deviceToken) {
        sendFirebasePush(user, alert, newStatus, ltpNum, entryCrossedUpdated, symbol).catch(
          (err) =>
            console.error(
              `❌ Firebase push error for ${alert._id}:`,
              err.message
            )
        );
      }

      // Telegram
      if (user.telegramChatId && user.telegramEnabled) {
        telegramQueue
          .add(
            { chatId: user.telegramChatId, alertDetails },
            {
              priority: notifPriority,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
            }
          )
          .catch((err) =>
            console.error(
              `❌ Telegram queue error for ${alert._id}:`,
              err.message
            )
          );
      }
    }

    // ───────────────── SOCKET.IO LIVE UPDATE ─────────────────
    if (io) {
      const userId = (user._id || user.id || "").toString();
      io.to(`user:${userId}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltpNum,
        trade_type: alert.trade_type,
        position: alert.position,
        entry_crossed: entryCrossedUpdated,
        timestamp: new Date().toISOString(),
      });

      if (
        [STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) &&
        newStatus !== oldStatus
      ) {
        io.to(`user:${userId}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          trading_symbol: alert.trading_symbol,
          price: ltpNum,
          status: newStatus,
          trade_type: alert.trade_type,
          position: alert.position,
          entry_crossed: entryCrossedUpdated,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  // Single DB round-trip for all alert updates in this tick
  if (bulkOps.length) {
    await Alert.bulkWrite(bulkOps);
  }
});

// ── Firebase Push helper ──
async function sendFirebasePush(user, alert, newStatus, ltpNum, entryCrossedUpdated, symbol) {
  const frontendUrl =
    config.frontendBaseUrl ||
    process.env.FRONTEND_URL ||
    "https://stock-notify-frontend-dev.vercel.app";

  const notificationConfig = {
    [STATUSES.SL_HIT]: {
      title: "🛑 Stop Loss Hit",
      body: `${alert.trading_symbol} at ₹${ltpNum.toFixed(
        2
      )} - ${alert.position.toUpperCase()}`,
      priority: "high",
    },
    [STATUSES.TARGET_HIT]: {
      title: "🎯 Target Reached",
      body: `${alert.trading_symbol} at ₹${ltpNum.toFixed(
        2
      )} - ${alert.position.toUpperCase()}`,
      priority: "high",
    },
    [STATUSES.ENTER]: {
      title: "🚀 Entry Condition Met",
      body: `${alert.trading_symbol} at ₹${ltpNum.toFixed(
        2
      )} - ${alert.position.toUpperCase()}`,
      priority: "high",
    },
  };

  const notifConfig =
    notificationConfig[newStatus] || notificationConfig[STATUSES.ENTER];

  await admin.messaging().send({
    token: user.deviceToken,
    notification: {
      title: notifConfig.title,
      body: notifConfig.body,
    },
    data: {
      alertId: alert._id.toString(),
      status: newStatus,
      symbol,
      trading_symbol: alert.trading_symbol,
      price: String(ltpNum),
      entry_price: String(alert.entry_price),
      stop_loss: String(alert.stop_loss),
      target_price: String(alert.target_price),
      position: alert.position,
      trade_type: alert.trade_type,
      entry_crossed: String(entryCrossedUpdated),
      timestamp: new Date().toISOString(),
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      url: `${frontendUrl}/dashboard/alerts`,
    },
    webpush: {
      fcmOptions: {
        link: `${frontendUrl}/dashboard/alerts`,
      },
      notification: {
        icon: `${frontendUrl}/favicon.ico`,
        badge: `${frontendUrl}/favicon.ico`,
        tag: `${alert._id}_${newStatus}`,
        requireInteraction: false,
      },
    },
    android: {
      priority: notifConfig.priority,
      notification: {
        channelId: "stock_alerts",
        priority: "high",
        sound: "default",
        tag: `${alert._id}_${newStatus}`,
        clickAction: `${frontendUrl}/dashboard/alerts`,
        icon: "notification_icon",
        color: "#1976d2",
      },
    },
    apns: {
      payload: {
        aps: {
          sound: "default",
          badge: 1,
          alert: {
            title: notifConfig.title,
            body: notifConfig.body,
          },
          "thread-id": alert._id.toString(),
          category: "STOCK_ALERT_CATEGORY",
        },
      },
      fcmOptions: {
        imageUrl: `${frontendUrl}/favicon.ico`,
      },
    },
  });
}

// ───────────────── MIGRATION ─────────────────
async function migrateAlerts() {
  const invalidStatus = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  if (invalidStatus.length) {
    await Alert.bulkWrite(
      invalidStatus.map((alert) => ({
        updateOne: {
          filter: { _id: alert._id },
          update: {
            $set: { status: STATUSES.PENDING, last_ltp: null, entry_crossed: false },
          },
        },
      }))
    );
  }

  const enteredAlerts = await Alert.find({
    status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] },
    entry_crossed: { $ne: true },
  });
  if (enteredAlerts.length) {
    await Alert.updateMany(
      { _id: { $in: enteredAlerts.map((a) => a._id) } },
      { $set: { entry_crossed: true } }
    );
  }

  const alertsWithoutField = await Alert.find({
    entry_crossed: { $exists: false },
  });
  if (alertsWithoutField.length) {
    await Alert.bulkWrite(
      alertsWithoutField.map((alert) => ({
        updateOne: {
          filter: { _id: alert._id },
          update: {
            $set: {
              entry_crossed: [
                STATUSES.ENTER,
                STATUSES.RUNNING,
                STATUSES.TARGET_HIT,
              ].includes(alert.status),
            },
          },
        },
      }))
    );
  }

  console.log(`✅ Migration complete: ${invalidStatus.length} invalid, ${enteredAlerts.length} entered, ${alertsWithoutField.length} missing field`);
}

module.exports = {
  migrateAlerts,
  startCacheRefresh,
  stopCacheRefresh,
  refreshAlertCache,
  STATUSES,
  TRADE_TYPES,
  alertQueue,
};
