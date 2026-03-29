// services/alertService.js
// ──────────────────────────────────────────────────────────────
// High-performance alert processor with IN-MEMORY alert cache.
// REFACTORED: Eliminated Bull queue overhead. Alert processing
// is now a direct function call via setImmediate(), cutting
// tick-to-alert latency from ~5-50ms (queue roundtrip) to <1ms.
//
// MongoDB is only hit for:
//   1. Cache refresh (every 30s) — 1 query
//   2. bulkWrite status updates — only when alerts actually change
// ──────────────────────────────────────────────────────────────

const admin = require("./firebase");
const config = require("../config/config");

const Alert = require("../models/Alert");
const emailQueue = require("../queues/emailQueue");
const telegramQueue = require("../queues/telegramQueue");
const ioInstance = require("./ioInstance");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const { STATUSES, TRADE_TYPES } = require("./constants");

// ───────────────────── STATE MACHINE HELPERS ─────────────────────
// Lookup tables eliminate branching per tick — O(1) dispatch
const SM = {
  [TRADE_TYPES.LONG]: {
    slHit:     (a, ltp) => ltp <= a.stop_loss,
    targetHit: (a, ltp) => ltp >= a.target_price,
    enter:     (a, ltp) => ltp < a.entry_price && ltp > a.stop_loss,
    running:   (a, prev, ltp) => prev < a.entry_price && ltp >= a.entry_price,
    nearEntry: (a, ltp) => {
      const diff = ((ltp - a.entry_price) / a.entry_price) * 100;
      return ltp > a.entry_price && diff <= 1;
    },
    stillRunning: (a, ltp) => ltp >= a.entry_price && ltp < a.target_price && ltp > a.stop_loss,
  },
  [TRADE_TYPES.SHORT]: {
    slHit:     (a, ltp) => ltp >= a.stop_loss,
    targetHit: (a, ltp) => ltp <= a.target_price,
    enter:     (a, ltp) => ltp > a.entry_price && ltp < a.stop_loss,
    running:   (a, prev, ltp) => prev > a.entry_price && ltp <= a.entry_price,
    nearEntry: (a, ltp) => {
      const diff = ((a.entry_price - ltp) / a.entry_price) * 100;
      return ltp < a.entry_price && diff <= 1;
    },
    stillRunning: (a, ltp) => ltp > a.target_price && ltp < a.stop_loss,
  },
};

function getStateFns(position) {
  return SM[position] || SM[TRADE_TYPES.LONG];
}

// ══════════════════════════════════════════════════════════
// IN-MEMORY ALERT CACHE
// ══════════════════════════════════════════════════════════
const alertCache = new Map();     // instrument_key -> CachedAlert[]
const alertIdIndex = new Map();   // alertId string -> { key, idx } for O(1) lookup
const CACHE_REFRESH_MS = 30_000;  // 30 seconds
let cacheRefreshTimer = null;
let cacheReady = false;
let isRefreshing = false;

async function refreshAlertCache() {
  if (isRefreshing) return;
  isRefreshing = true;

  const start = Date.now();
  try {
    const alerts = await Alert.find({
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    }).populate("user", "email deviceToken telegramChatId telegramEnabled _id").lean();

    const newCache = new Map();
    for (const alert of alerts) {
      if (!alert.user || !alert.user.email) continue;
      const key = alert.instrument_key;
      if (!newCache.has(key)) newCache.set(key, []);
      newCache.get(key).push(alert);
    }

    // Atomic swap
    alertCache.clear();
    alertIdIndex.clear();
    for (const [key, value] of newCache) {
      alertCache.set(key, value);
      // Build O(1) alertId -> location index
      for (let i = 0; i < value.length; i++) {
        alertIdIndex.set(value[i]._id.toString(), { key, idx: i });
      }
    }

    metrics.observe("alert_cache_refresh_ms", Date.now() - start);
    metrics.gauge("alert_cache_stocks", newCache.size);
    metrics.gauge("alert_cache_alerts", alerts.length);

    if (!cacheReady) {
      logger.info(`Alert cache initialized: ${alerts.length} alerts across ${newCache.size} stocks`);
      cacheReady = true;
    }
  } catch (err) {
    logger.error("Alert cache refresh error", { error: err.message });
  } finally {
    isRefreshing = false;
  }
}

function startCacheRefresh() {
  refreshAlertCache();
  cacheRefreshTimer = setInterval(refreshAlertCache, CACHE_REFRESH_MS);
  cacheRefreshTimer.unref();
}

function stopCacheRefresh() {
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
  }
}

function updateCacheEntry(alertId, updates) {
  const alertIdStr = alertId.toString();
  const loc = alertIdIndex.get(alertIdStr);
  if (!loc) return;

  const alerts = alertCache.get(loc.key);
  if (!alerts || loc.idx >= alerts.length) return;

  const alert = alerts[loc.idx];
  // Verify identity (index may be stale after splices)
  if (alert._id.toString() !== alertIdStr) {
    // Fallback: linear scan if index is stale (rare, only after terminal removals)
    for (let i = 0; i < alerts.length; i++) {
      if (alerts[i]._id.toString() === alertIdStr) {
        Object.assign(alerts[i], updates);
        if (updates.status === STATUSES.SL_HIT || updates.status === STATUSES.TARGET_HIT) {
          alerts.splice(i, 1);
          alertIdIndex.delete(alertIdStr);
        }
        return;
      }
    }
    alertIdIndex.delete(alertIdStr);
    return;
  }

  Object.assign(alert, updates);
  if (updates.status === STATUSES.SL_HIT || updates.status === STATUSES.TARGET_HIT) {
    alerts.splice(loc.idx, 1);
    alertIdIndex.delete(alertIdStr);
    // Note: indices for other alerts in this array become stale after splice,
    // but they self-correct via the identity check above or on next cache refresh
  }
}

// ── LTP dedup cache with LRU eviction ──
const lastProcessedLtp = new Map();
const MAX_LTP_CACHE = 5000;

function dedupLtp(symbol, ltpNum) {
  if (lastProcessedLtp.get(symbol) === ltpNum) return true; // duplicate
  // LRU eviction: delete oldest entries when at capacity
  if (lastProcessedLtp.size >= MAX_LTP_CACHE) {
    const firstKey = lastProcessedLtp.keys().next().value;
    lastProcessedLtp.delete(firstKey);
  }
  lastProcessedLtp.set(symbol, ltpNum);
  return false;
}

// ── Notification trigger statuses ──
const NOTIFY_STATUSES = new Set([STATUSES.SL_HIT, STATUSES.TARGET_HIT, STATUSES.ENTER]);
const TERMINAL_STATUSES = new Set([STATUSES.SL_HIT, STATUSES.TARGET_HIT]);

// ═══════════════════════════════════════════════════════
// DIRECT ALERT PROCESSOR — called via setImmediate from tick handler
// No Bull queue overhead. Pure in-memory processing.
// ═══════════════════════════════════════════════════════
async function processTickAlerts(symbol, ltpNum) {
  if (!cacheReady) return;
  if (dedupLtp(symbol, ltpNum)) return;

  const alerts = alertCache.get(symbol);
  if (!alerts || !alerts.length) return;

  const start = Date.now();
  const bulkOps = [];
  const io = ioInstance.getIo();
  // Batch socket emissions per user to reduce IO overhead
  const userStatusUpdates = new Map(); // userId -> updates[]
  const userTriggers = new Map();      // userId -> triggers[]

  // Pre-resolve state functions once per position type seen in this batch
  const fnCache = new Map();

  for (let i = 0; i < alerts.length; i++) {
    const alert = alerts[i];
    const user = alert.user;
    if (!user || !user.email) continue;

    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    const oldStatus = alert.status ?? STATUSES.PENDING;
    let entryCrossed = Boolean(alert.entry_crossed);

    // ───────────────── STATE MACHINE ─────────────────
    let fn = fnCache.get(alert.position);
    if (!fn) {
      fn = getStateFns(alert.position);
      fnCache.set(alert.position, fn);
    }
    let newStatus;

    if (fn.slHit(alert, ltpNum)) {
      newStatus = STATUSES.SL_HIT;
    } else if (fn.targetHit(alert, ltpNum) && entryCrossed) {
      newStatus = STATUSES.TARGET_HIT;
    } else if (fn.enter(alert, ltpNum) && !entryCrossed) {
      newStatus = STATUSES.ENTER;
      entryCrossed = true;
    } else if (entryCrossed && fn.running(alert, previous, ltpNum)) {
      newStatus = STATUSES.RUNNING;
    } else if ((oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) && entryCrossed) {
      if (fn.stillRunning(alert, ltpNum) || fn.enter(alert, ltpNum)) {
        newStatus = STATUSES.RUNNING;
      } else {
        newStatus = oldStatus;
      }
    } else if (fn.nearEntry(alert, ltpNum) && !entryCrossed) {
      newStatus = STATUSES.NEAR_ENTRY;
    } else {
      newStatus = STATUSES.PENDING;
    }

    const statusChanged = newStatus !== oldStatus;
    const entryCrossedChanged = entryCrossed !== alert.entry_crossed;

    // Skip if nothing changed (status, entry_crossed, and ltp are all the same)
    if (!statusChanged && !entryCrossedChanged && alert.last_ltp === ltpNum) {
      continue;
    }

    // Update in-memory cache immediately (always keep last_ltp current in memory)
    updateCacheEntry(alert._id, {
      status: newStatus,
      last_ltp: ltpNum,
      entry_crossed: entryCrossed,
    });

    // Only write last_ltp to DB when status actually changes; skip the write
    // entirely if only ltp moved and nothing meaningful changed.
    if (!statusChanged && !entryCrossedChanged) {
      // Only last_ltp changed — skip DB write to avoid write amplification
      continue;
    }

    // Build $set payload: always include status and entry_crossed when they changed;
    // include last_ltp only when there is a real status transition.
    const $setPayload = { status: newStatus, entry_crossed: entryCrossed };
    if (statusChanged) {
      $setPayload.last_ltp = ltpNum;
    }

    // Collect bulk DB update
    bulkOps.push({
      updateOne: {
        filter: { _id: alert._id },
        update: { $set: $setPayload },
      },
    });

    if (statusChanged) {
      logger.info(`Alert transition: ${alert.trading_symbol} ${oldStatus} -> ${newStatus} at ${ltpNum}`);
    }

    // ───────────────── NOTIFICATIONS ─────────────────
    if (NOTIFY_STATUSES.has(newStatus) && statusChanged) {
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

      const notifPriority = TERMINAL_STATUSES.has(newStatus) ? 1 : 2;

      // Email
      emailQueue
        .add({ userEmail: user.email, alertDetails }, { priority: notifPriority, removeOnComplete: true, removeOnFail: false })
        .catch((err) => logger.error(`Email queue error for ${alert._id}`, { error: err.message }));

      // Firebase Push
      if (user.deviceToken) {
        sendFirebasePush(user, alert, newStatus, ltpNum, entryCrossed, symbol)
          .catch((err) => logger.error(`Firebase push error for ${alert._id}`, { error: err.message }));
      }

      // Telegram
      if (user.telegramChatId && user.telegramEnabled) {
        telegramQueue
          .add(
            { chatId: user.telegramChatId, alertDetails },
            { priority: notifPriority, removeOnComplete: true, removeOnFail: false, attempts: 3, backoff: { type: "exponential", delay: 2000 } }
          )
          .catch((err) => logger.error(`Telegram queue error for ${alert._id}`, { error: err.message }));
      }

      metrics.inc("alerts_notified");
    }

    // ───────────────── COLLECT SOCKET.IO UPDATES (batched per user) ─────────────────
    if (io) {
      const userId = (user._id || user.id || "").toString();
      const ts = new Date().toISOString();

      if (!userStatusUpdates.has(userId)) userStatusUpdates.set(userId, []);
      userStatusUpdates.get(userId).push({
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltpNum,
        trade_type: alert.trade_type,
        position: alert.position,
        entry_crossed: entryCrossed,
        timestamp: ts,
      });

      if (TERMINAL_STATUSES.has(newStatus) && statusChanged) {
        if (!userTriggers.has(userId)) userTriggers.set(userId, []);
        userTriggers.get(userId).push({
          alertId: alert._id,
          symbol,
          trading_symbol: alert.trading_symbol,
          price: ltpNum,
          status: newStatus,
          trade_type: alert.trade_type,
          position: alert.position,
          entry_crossed: entryCrossed,
          timestamp: ts,
        });
      }
    }
  }

  // ───────────────── EMIT BATCHED SOCKET UPDATES ─────────────────
  if (io) {
    for (const [userId, updates] of userStatusUpdates) {
      if (updates.length === 1) {
        io.to(`user:${userId}`).emit("alert_status_updated", updates[0]);
      } else {
        io.to(`user:${userId}`).emit("alert_status_batch", updates);
      }
    }
    for (const [userId, triggers] of userTriggers) {
      for (const trigger of triggers) {
        io.to(`user:${userId}`).emit("alert_triggered", trigger);
      }
    }
  }

  // Single DB round-trip for all alert updates
  if (bulkOps.length) {
    try {
      await Alert.bulkWrite(bulkOps, { ordered: false });
      metrics.inc("alert_db_writes", bulkOps.length);
    } catch (err) {
      logger.error("Alert bulkWrite error", { error: err.message, ops: bulkOps.length });
    }
  }

  metrics.observe("alert_process_latency_ms", Date.now() - start);
  metrics.inc("alert_ticks_processed");
}

// ── Firebase Push helper ──
async function sendFirebasePush(user, alert, newStatus, ltpNum, entryCrossed, symbol) {
  const frontendUrl = config.frontendBaseUrl || process.env.FRONTEND_URL || "https://stock-notify-frontend-dev.vercel.app";

  const titles = {
    [STATUSES.SL_HIT]: "Stop Loss Hit",
    [STATUSES.TARGET_HIT]: "Target Reached",
    [STATUSES.ENTER]: "Entry Condition Met",
  };

  const title = titles[newStatus] || titles[STATUSES.ENTER];
  const body = `${alert.trading_symbol} at ${ltpNum.toFixed(2)} - ${alert.position.toUpperCase()}`;

  await admin.messaging().send({
    token: user.deviceToken,
    notification: { title, body },
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
      entry_crossed: String(entryCrossed),
      timestamp: new Date().toISOString(),
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      url: `${frontendUrl}/dashboard/alerts`,
    },
    webpush: {
      fcmOptions: { link: `${frontendUrl}/dashboard/alerts` },
      notification: {
        icon: `${frontendUrl}/favicon.ico`,
        badge: `${frontendUrl}/favicon.ico`,
        tag: `${alert._id}_${newStatus}`,
        requireInteraction: false,
      },
    },
    android: {
      priority: "high",
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
          alert: { title, body },
          "thread-id": alert._id.toString(),
          category: "STOCK_ALERT_CATEGORY",
        },
      },
      fcmOptions: { imageUrl: `${frontendUrl}/favicon.ico` },
    },
  });
}

// ───────────────── MIGRATION ─────────────────
async function migrateAlerts() {
  const invalidStatus = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  }).lean();
  if (invalidStatus.length) {
    await Alert.bulkWrite(
      invalidStatus.map((alert) => ({
        updateOne: {
          filter: { _id: alert._id },
          update: { $set: { status: STATUSES.PENDING, last_ltp: null, entry_crossed: false } },
        },
      }))
    );
  }

  const enteredAlerts = await Alert.find({
    status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] },
    entry_crossed: { $ne: true },
  }).lean();
  if (enteredAlerts.length) {
    await Alert.updateMany(
      { _id: { $in: enteredAlerts.map((a) => a._id) } },
      { $set: { entry_crossed: true } }
    );
  }

  const alertsWithoutField = await Alert.find({
    entry_crossed: { $exists: false },
  }).lean();
  if (alertsWithoutField.length) {
    await Alert.bulkWrite(
      alertsWithoutField.map((alert) => ({
        updateOne: {
          filter: { _id: alert._id },
          update: {
            $set: {
              entry_crossed: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT].includes(alert.status),
            },
          },
        },
      }))
    );
  }

  logger.info(`Migration complete: ${invalidStatus.length} invalid, ${enteredAlerts.length} entered, ${alertsWithoutField.length} missing field`);
}

module.exports = {
  processTickAlerts,
  migrateAlerts,
  startCacheRefresh,
  stopCacheRefresh,
  refreshAlertCache,
  STATUSES,
  TRADE_TYPES,
};
