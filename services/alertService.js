// services/alertService.js - REFACTORED & OPTIMIZED

const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailQueue = require("../queues/emailQueue");
const telegramQueue = require("../queues/telegramQueue");
const Bull = require("bull");
const config = require("../config/config");
const admin = require("firebase-admin");
const ioInstance = require("./ioInstance");

// ------------------- CONSTANTS -------------------
const STATUSES = {
  PENDING: "pending",
  NEAR_ENTRY: "nearEntry",
  ENTER: "enter",
  RUNNING: "running",
  SL_HIT: "slHit",
  TARGET_HIT: "targetHit",
};

const TRADE_TYPES = {
  BULLISH: "bullish",
  BEARISH: "bearish",
};

const NOTIFICATION_CONFIG = {
  slHit: { emoji: '🛑', title: 'Stop Loss Hit', priority: 'high' },
  targetHit: { emoji: '🎯', title: 'Target Reached', priority: 'high' },
  enter: { emoji: '🚀', title: 'Entry Condition Met', priority: 'high' }
};

// ------------------- STRATEGY PATTERN FOR TREND CALCULATIONS -------------------
class TrendStrategy {
  constructor(trend) {
    this.isBullish = trend === TRADE_TYPES.BULLISH;
  }

  slHit(alert, ltp) {
    return this.isBullish ? ltp <= alert.stop_loss : ltp >= alert.stop_loss;
  }

  targetHit(alert, ltp) {
    return this.isBullish ? ltp >= alert.target_price : ltp <= alert.target_price;
  }

  enterCondition(alert, ltp) {
    return this.isBullish 
      ? (ltp < alert.entry_price && ltp > alert.stop_loss)
      : (ltp > alert.entry_price && ltp < alert.stop_loss);
  }

  runningCondition(alert, previous, ltp) {
    return this.isBullish
      ? (previous < alert.entry_price && ltp >= alert.entry_price)
      : (previous > alert.entry_price && ltp <= alert.entry_price);
  }

  nearEntry(alert, ltp) {
    const diffPercent = this.isBullish
      ? ((ltp - alert.entry_price) / alert.entry_price) * 100
      : ((alert.entry_price - ltp) / alert.entry_price) * 100;
    return this.isBullish 
      ? (ltp > alert.entry_price && diffPercent <= 1)
      : (ltp < alert.entry_price && diffPercent <= 1);
  }

  stillRunning(alert, ltp) {
    return this.isBullish
      ? (ltp >= alert.entry_price && ltp < alert.target_price && ltp > alert.stop_loss)
      : (ltp > alert.target_price && ltp < alert.stop_loss);
  }
}

// ------------------- QUEUE SETUP -------------------
const alertQueue = new Bull("alert-processing", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  limiter: { max: 1000, duration: 1000 },
  settings: {
    maxStalledCount: 2,
    stalledInterval: 5000,
    lockDuration: 30000
  }
});

// ------------------- HELPER FUNCTIONS -------------------
function getLtpFromTick(tick) {
  return tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;
}

function shouldSkipUpdate(alert, newStatus, ltp, entryCrossed) {
  return alert.status === newStatus && 
         alert.last_ltp === ltp && 
         alert.entry_crossed === entryCrossed;
}

function shouldTriggerNotification(newStatus, oldStatus) {
  const triggerStatuses = [STATUSES.SL_HIT, STATUSES.TARGET_HIT, STATUSES.ENTER];
  return triggerStatuses.includes(newStatus) && newStatus !== oldStatus;
}

// ------------------- NOTIFICATION HANDLERS -------------------
async function sendEmailNotification(user, alert, ltp, newStatus) {
  try {
    await emailQueue.add(
      {
        userEmail: user.email,
        alertDetails: buildAlertDetails(alert, ltp, newStatus),
      },
      {
        priority: [STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) ? 1 : 2,
        removeOnComplete: true,
        removeOnFail: false,
      }
    );
    console.log(`📧 Email queued for ${alert.trading_symbol}`);
  } catch (error) {
    console.error(`❌ Email queue failed for alert ${alert._id}:`, error.message);
  }
}

async function sendFirebaseNotification(user, alert, ltp, newStatus, entryCrossed) {
  if (!user.deviceToken) return;

  try {
    const notifConfig = NOTIFICATION_CONFIG[newStatus] || NOTIFICATION_CONFIG.enter;
    
    await admin.messaging().send({
      token: user.deviceToken,
      notification: {
        title: notifConfig.title,
        body: `${alert.trading_symbol} at ₹${ltp.toFixed(2)} - ${alert.trend.toUpperCase()}`,
      },
      data: buildNotificationData(alert, ltp, newStatus, entryCrossed),
      webpush: buildWebpushConfig(alert, newStatus),
      android: buildAndroidConfig(alert, newStatus, notifConfig),
      apns: buildApnsConfig(alert, notifConfig),
    });
    
    console.log(`✅ 🔔 Firebase notification sent for ${alert.trading_symbol}`);
  } catch (err) {
    console.error(`❌ Firebase push failed for alert ${alert._id}:`, err.message);
  }
}

async function sendTelegramNotification(user, alert, ltp, newStatus) {
  if (!user.telegramChatId || !user.telegramEnabled) return;

  try {
    await telegramQueue.add(
      {
        chatId: user.telegramChatId,
        alertDetails: buildAlertDetails(alert, ltp, newStatus),
      },
      {
        priority: [STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) ? 1 : 2,
        removeOnComplete: true,
        removeOnFail: false,
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 }
      }
    );
    console.log(`📱 Telegram queued for ${alert.trading_symbol}`);
  } catch (error) {
    console.error(`❌ Telegram queue failed for alert ${alert._id}:`, error.message);
  }
}

function emitSocketUpdate(user, alert, symbol, ltp, newStatus, oldStatus, entryCrossed) {
  const io = ioInstance.getIo();
  if (!io) return;

  const userRoom = `user:${user._id.toString()}`;
  const basePayload = {
    alertId: alert._id,
    status: newStatus,
    symbol,
    price: ltp,
    trade_type: alert.trade_type,
    trend: alert.trend,
    entry_crossed: entryCrossed,
    timestamp: new Date().toISOString(),
  };

  io.to(userRoom).emit("alert_status_updated", basePayload);

  if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) && newStatus !== oldStatus) {
    io.to(userRoom).emit("alert_triggered", {
      ...basePayload,
      trading_symbol: alert.trading_symbol,
    });
  }
}

// ------------------- BUILDER FUNCTIONS -------------------
function buildAlertDetails(alert, ltp, newStatus) {
  return {
    trading_symbol: alert.trading_symbol,
    status: newStatus,
    current_price: ltp,
    entry_price: alert.entry_price,
    stop_loss: alert.stop_loss,
    target_price: alert.target_price,
    trend: alert.trend,
    trade_type: alert.trade_type,
    level: alert.level,
    triggered_at: new Date(),
  };
}

function buildNotificationData(alert, ltp, newStatus, entryCrossed) {
  return {
    alertId: alert._id.toString(),
    status: newStatus,
    symbol: alert.instrument_key,
    trading_symbol: alert.trading_symbol,
    price: ltp.toString(),
    entry_price: alert.entry_price.toString(),
    stop_loss: alert.stop_loss.toString(),
    target_price: alert.target_price.toString(),
    trend: alert.trend,
    trade_type: alert.trade_type,
    entry_crossed: entryCrossed.toString(),
    timestamp: new Date().toISOString(),
    click_action: 'FLUTTER_NOTIFICATION_CLICK',
    url: `${config.frontendBaseUrl}/dashboard/alerts`,
  };
}

function buildWebpushConfig(alert, newStatus) {
  return {
    fcmOptions: { link: `${config.frontendBaseUrl}/dashboard/alerts` },
    notification: {
      icon: `${config.frontendBaseUrl}/favicon.ico`,
      badge: `${config.frontendBaseUrl}/favicon.ico`,
      tag: `${alert._id}_${newStatus}`,
      requireInteraction: false,
    }
  };
}

function buildAndroidConfig(alert, newStatus, notifConfig) {
  return {
    priority: notifConfig.priority,
    notification: {
      channelId: 'stock_alerts',
      priority: 'high',
      sound: 'default',
      tag: `${alert._id}_${newStatus}`,
      clickAction: `${config.frontendBaseUrl}/dashboard/alerts`,
      icon: 'notification_icon',
      color: '#1976d2',
    }
  };
}

function buildApnsConfig(alert, notifConfig) {
  return {
    payload: {
      aps: {
        sound: 'default',
        badge: 1,
        alert: { title: notifConfig.title, body: notifConfig.body },
        'thread-id': alert._id.toString(),
        'category': 'STOCK_ALERT_CATEGORY',
      }
    },
    fcmOptions: { imageUrl: `${config.frontendBaseUrl}/favicon.ico` }
  };
}

// ------------------- CORE STATUS DETERMINATION -------------------
function determineNewStatus(alert, ltp, previous, strategy) {
  const entryCrossed = alert.entry_crossed || false;

  // Priority 1: Check SL hit
  if (strategy.slHit(alert, ltp)) {
    return { status: STATUSES.SL_HIT, entryCrossed };
  }

  // Priority 2: Check target hit (only if entry was crossed)
  if (strategy.targetHit(alert, ltp) && entryCrossed) {
    return { status: STATUSES.TARGET_HIT, entryCrossed };
  }

  // Priority 3: Check entry condition
  if (strategy.enterCondition(alert, ltp) && !entryCrossed) {
    console.log(`🎯 FIRST TIME Entry crossed for ${alert.trading_symbol} at ₹${ltp}`);
    return { status: STATUSES.ENTER, entryCrossed: true };
  }

  // Priority 4: Check running condition
  if (entryCrossed && strategy.runningCondition(alert, previous, ltp)) {
    return { status: STATUSES.RUNNING, entryCrossed };
  }

  // Priority 5: Maintain running/enter status if still valid
  if ([STATUSES.ENTER, STATUSES.RUNNING].includes(alert.status) && entryCrossed) {
    if (strategy.stillRunning(alert, ltp) || strategy.enterCondition(alert, ltp)) {
      return { status: STATUSES.RUNNING, entryCrossed };
    }
  }

  // Priority 6: Check near entry
  if (strategy.nearEntry(alert, ltp) && !entryCrossed) {
    return { status: STATUSES.NEAR_ENTRY, entryCrossed };
  }

  // Default: Pending
  return { status: STATUSES.PENDING, entryCrossed };
}

// ------------------- QUEUE PROCESSOR -------------------
alertQueue.process(async (job) => {
  const { symbol, tick } = job.data;
  const ltp = getLtpFromTick(tick);
  if (!ltp) return;

  const alerts = await Alert.find({
    instrument_key: symbol,
    status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
  }).populate("user", "email deviceToken telegramChatId telegramEnabled _id");

  for (const alert of alerts) {
    const user = alert.user;
    if (!user?.email) continue;

    const strategy = new TrendStrategy(alert.trend);
    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    const oldStatus = alert.status;

    const { status: newStatus, entryCrossed } = determineNewStatus(alert, ltp, previous, strategy);

    // Skip if no changes
    if (shouldSkipUpdate(alert, newStatus, ltp, entryCrossed)) continue;

    // Update alert
    alert.status = newStatus;
    alert.last_ltp = ltp;
    alert.entry_crossed = entryCrossed;
    await alert.save();

    if (newStatus !== oldStatus) {
      console.log(`📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltp}`);
    }

    // Send notifications
    if (shouldTriggerNotification(newStatus, oldStatus)) {
      await Promise.allSettled([
        sendEmailNotification(user, alert, ltp, newStatus),
        sendFirebaseNotification(user, alert, ltp, newStatus, entryCrossed),
        sendTelegramNotification(user, alert, ltp, newStatus),
      ]);
    }

    // Emit socket update
    emitSocketUpdate(user, alert, symbol, ltp, newStatus, oldStatus, entryCrossed);
  }
});

// ------------------- QUEUE CLEANUP (Optimized with single interval) -------------------
setInterval(async () => {
  try {
    await Promise.all([
      alertQueue.clean(10000, "completed"),
      alertQueue.clean(10000, "failed"),
      alertQueue.clean(10000, "wait"),
      alertQueue.clean(10000, "active"),
    ]);
    console.log("✅ Alert queue cleaned");
  } catch (error) {
    console.error("❌ Queue cleanup error:", error.message);
  }
}, 10000);

// ------------------- MIGRATION -------------------
async function migrateAlerts() {
  try {
    const [invalidAlerts, enteredAlerts, missingFieldAlerts] = await Promise.all([
      Alert.find({ status: { $nin: Object.values(STATUSES) } }),
      Alert.find({ status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] } }),
      Alert.find({ entry_crossed: { $exists: false } })
    ]);

    const bulkOps = [];

    invalidAlerts.forEach(alert => {
      bulkOps.push({
        updateOne: {
          filter: { _id: alert._id },
          update: { status: STATUSES.PENDING, last_ltp: null, entry_crossed: false }
        }
      });
    });

    enteredAlerts.forEach(alert => {
      if (!alert.entry_crossed) {
        bulkOps.push({
          updateOne: {
            filter: { _id: alert._id },
            update: { entry_crossed: true }
          }
        });
      }
    });

    missingFieldAlerts.forEach(alert => {
      bulkOps.push({
        updateOne: {
          filter: { _id: alert._id },
          update: { 
            entry_crossed: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT].includes(alert.status)
          }
        }
      });
    });

    if (bulkOps.length > 0) {
      await Alert.bulkWrite(bulkOps);
    }

    console.log(`✅ Migrated ${bulkOps.length} alerts successfully`);
  } catch (error) {
    console.error("❌ Migration failed:", error.message);
  }
}

module.exports = {
  migrateAlerts,
  STATUSES,
  TRADE_TYPES,
  alertQueue,
};
