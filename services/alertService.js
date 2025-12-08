// services/alertService.js

const Bull = require("bull");
const admin = require("./firebase");
const config = require("../config/config");

const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailQueue = require("../queues/emailQueue");
const telegramQueue = require("../queues/telegramQueue");
const ioInstance = require("./ioInstance");

const { STATUSES, TRADE_TYPES } = require("./constants");

// ------------------- UNIFIED HELPERS -------------------
function isSlHit(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? ltp >= alert.stop_loss
    : ltp <= alert.stop_loss;
}

function isTargetHit(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? ltp <= alert.target_price
    : ltp >= alert.target_price;
}

function isEnterCondition(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? ltp > alert.entry_price && ltp < alert.stop_loss
    : ltp < alert.entry_price && ltp > alert.stop_loss;
}

function isRunningCondition(alert, previous, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? previous > alert.entry_price && ltp <= alert.entry_price
    : previous < alert.entry_price && ltp >= alert.entry_price;
}

function isNearEntry(alert, ltp) {
  if (alert.position === TRADE_TYPES.SHORT) {
    const diffPercent = ((alert.entry_price - ltp) / alert.entry_price) * 100;
    return ltp < alert.entry_price && diffPercent <= 1;
  } else {
    const diffPercent = ((ltp - alert.entry_price) / alert.entry_price) * 100;
    return ltp > alert.entry_price && diffPercent <= 1;
  }
}

function isStillRunning(alert, ltp) {
  return alert.position === TRADE_TYPES.SHORT
    ? ltp > alert.target_price && ltp < alert.stop_loss
    : ltp >= alert.entry_price && ltp < alert.target_price && ltp > alert.stop_loss;
}

// ------------------- QUEUE SETUP -------------------
const alertQueue = new Bull("alert-processing", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  limiter: { max: 1000, duration: 1000 },
});

// ------------------- QUEUE PROCESSOR -------------------
// ------------------- QUEUE PROCESSOR -------------------
alertQueue.process(async (job) => {
  const { symbol, tick, timestamp } = job.data;

  // Monitor Queue Lag
  if (timestamp) {
    const lag = Date.now() - timestamp;
    if (lag > 1000) {
      console.warn(`⚠️ High Queue Lag for ${symbol}: ${lag}ms`);
    }
  }

  const ltp =
    tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;

  const ltpNum = typeof ltp === "number" ? ltp : Number(ltp);
  if (!ltpNum || Number.isNaN(ltpNum)) return;

  // FAST PATH: Fetch from Redis instead of MongoDB
  let alerts = await redisService.getCachedAlerts(symbol);

  // Fallback: If Redis is empty, check DB once (handling cold start/eviction)
  // But ideally, we rely on the sync script.
  if (!alerts || alerts.length === 0) {
    // Optional: You could fetch from DB here if you suspect cache miss,
    // but for high perf, we assume cache is the source of truth.
    // To be safe during migration, let's just return if empty.
    return;
  }

  for (const alert of alerts) {
    // Hydrate user if needed, but Redis stores the user ID in the alert object.
    // If we need user details (email/phone), we might need to fetch user.
    // For speed, let's assume we need to fetch user ONLY if we trigger an alert.

    // NOTE: Redis stores plain JSON. We need to handle it carefully.

    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    let newStatus = alert.status ?? STATUSES.PENDING;
    const oldStatus = alert.status;
    let entryCrossedUpdated = Boolean(alert.entry_crossed);

    // ------------------- STATE MACHINE -------------------
    if (isSlHit(alert, ltpNum)) {
      newStatus = STATUSES.SL_HIT;
    } else if (isTargetHit(alert, ltpNum) && entryCrossedUpdated) {
      newStatus = STATUSES.TARGET_HIT;
    } else {
      if (isEnterCondition(alert, ltpNum) && !entryCrossedUpdated) {
        newStatus = STATUSES.ENTER;
        entryCrossedUpdated = true;
        console.log(
          `🎯 FIRST TIME Entry crossed for ${alert.trading_symbol} at ₹${ltpNum}`
        );
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

    // UPDATE STATE
    alert.status = newStatus;
    alert.last_ltp = ltpNum;
    alert.entry_crossed = entryCrossedUpdated;

    // 1. Update Redis (Fast)
    if (
      newStatus === STATUSES.SL_HIT ||
      newStatus === STATUSES.TARGET_HIT
    ) {
      // If terminal state, remove from active alerts cache
      await redisService.removeCachedAlert(symbol, alert._id);
    } else {
      // Update cache with new state
      await redisService.updateCachedAlert(alert);
    }

    // 2. Update MongoDB (Async/Behind)
    // We do this to persist state, but we don't await it to block the loop if we want extreme speed.
    // However, for safety, awaiting is fine as this only happens on CHANGE.
    await Alert.findByIdAndUpdate(alert._id, {
      status: newStatus,
      last_ltp: ltpNum,
      entry_crossed: entryCrossedUpdated,
    });

    if (newStatus !== oldStatus) {
      console.log(
        `📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltpNum} (Entry crossed: ${entryCrossedUpdated})`
      );
    }

    // Fetch user for notifications
    const user = await User.findById(alert.user);
    if (!user) continue; // Should not happen

    if (newStatus !== oldStatus) {
      console.log(
        `📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltpNum} (Entry crossed: ${entryCrossedUpdated})`
      );
    }

    // ------------------- NOTIFICATIONS -------------------
    const emailTriggerStatuses = new Set([
      STATUSES.SL_HIT,
      STATUSES.TARGET_HIT,
      STATUSES.ENTER,
    ]);

    if (emailTriggerStatuses.has(newStatus) && newStatus !== oldStatus) {
      // Email
      try {
        await emailQueue.add(
          {
            userEmail: user.email,
            alertDetails: {
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
            },
          },
          {
            priority:
              newStatus === STATUSES.SL_HIT || newStatus === STATUSES.TARGET_HIT
                ? 1
                : 2,
            removeOnComplete: true,
            removeOnFail: false,
          }
        );
        console.log(
          `📧 Email queued for ${alert.trading_symbol} to ${user.email} - Status: ${newStatus}`
        );
      } catch (error) {
        console.error(
          `❌ Failed to queue email for alert ${alert._id}:`,
          error.message
        );
      }

      // Push via Firebase
      (async () => {
        try {
          if (user.deviceToken) {
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
              notificationConfig[newStatus] ||
              notificationConfig[STATUSES.ENTER];

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
            console.log(
              `✅ 🔔 Firebase notification sent for ${alert.trading_symbol} - Status: ${newStatus}`
            );
          }
        } catch (err) {
          console.error(
            `❌ Firebase push notification failed for alert ${alert._id}:`,
            err.message
          );
        }
      })();

      // Telegram
      if (user.telegramChatId && user.telegramEnabled) {
        try {
          await telegramQueue.add(
            {
              chatId: user.telegramChatId,
              alertDetails: {
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
              },
            },
            {
              priority:
                newStatus === STATUSES.SL_HIT ||
                  newStatus === STATUSES.TARGET_HIT
                  ? 1
                  : 2,
              removeOnComplete: true,
              removeOnFail: false,
              attempts: 3,
              backoff: { type: "exponential", delay: 2000 },
            }
          );
          console.log(
            `📱 Telegram queued for ${alert.trading_symbol} to chat ${user.telegramChatId} - Status: ${newStatus}`
          );
        } catch (error) {
          console.error(
            `❌ Failed to queue Telegram for alert ${alert._id}:`,
            error.message
          );
        }
      }
    }

    // ------------------- SOCKET.IO LIVE UPDATE -------------------
    const io = ioInstance.getIo();
    if (io) {
      io.to(`user:${user._id.toString()}`).emit("alert_status_updated", {
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
        io.to(`user:${user._id.toString()}`).emit("alert_triggered", {
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
});

// ------------------- QUEUE CLEANUP -------------------
// Clean completed/failed periodically (10 minutes). Do NOT force-clean active jobs.
setInterval(async () => {
  await alertQueue.clean(60 * 60 * 1000, "completed"); // older than 1h
  await alertQueue.clean(60 * 60 * 1000, "failed"); // older than 1h
  console.log("✅ Alert queue cleaned (completed/failed > 1h)");
}, 10 * 60 * 1000);

// ------------------- MIGRATION -------------------
async function migrateAlerts() {
  const invalidStatus = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  for (const alert of invalidStatus) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    alert.entry_crossed = false;
    await alert.save();
  }

  const enteredAlerts = await Alert.find({
    status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] },
  });
  for (const alert of enteredAlerts) {
    if (!alert.entry_crossed) {
      alert.entry_crossed = true;
      await alert.save();
    }
  }

  const alertsWithoutField = await Alert.find({
    entry_crossed: { $exists: false },
  });
  for (const alert of alertsWithoutField) {
    alert.entry_crossed = [
      STATUSES.ENTER,
      STATUSES.RUNNING,
      STATUSES.TARGET_HIT,
    ].includes(alert.status);
    await alert.save();
  }

  console.log(`✅ Migrated ${invalidStatus.length} alerts to pending.`);
  console.log(
    `✅ Set entry_crossed for ${enteredAlerts.length} entered alerts.`
  );
  console.log(
    `✅ Initialized entry_crossed for ${alertsWithoutField.length} alerts.`
  );
  console.log(
    `✅ Initialized entry_crossed for ${alertsWithoutField.length} alerts.`
  );
}

// ------------------- SYNC / WARMUP -------------------
async function syncAlertsToRedis() {
  console.log("🔄 Syncing active alerts to Redis...");
  const activeAlerts = await Alert.find({
    status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
  });

  // Clear existing alert keys to avoid stale data? 
  // Ideally yes, but for now let's just overwrite.
  // A full flush of 'alerts:active:*' might be safer but expensive if many keys.
  // Let's iterate and set.

  let count = 0;
  for (const alert of activeAlerts) {
    await redisService.cacheAlert(alert);
    count++;
  }
  console.log(`✅ Synced ${count} alerts to Redis.`);
}

module.exports = {
  migrateAlerts,
  syncAlertsToRedis, // Exported
  STATUSES,
  TRADE_TYPES,
  alertQueue, // exported for external use if needed
};
