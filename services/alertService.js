const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailService = require("../utils/email");
const Bull = require("bull");
const config = require("../config/config");
const admin = require("firebase-admin"); // Firebase already initialized in app.js
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

// ------------------- Helper functions -------------------

// Stop Loss condition
function isSlHit(alert, ltp) {
  return ltp <= alert.stop_loss;
}

// Target condition
function isTargetHit(alert, ltp) {
  return ltp >= alert.target_price;
}

// Enter condition: price between stoploss and entry
function isEnterCondition(alert, ltp) {
  return ltp < alert.entry_price && ltp > alert.stop_loss;
}

// Running condition: must cross entry once, then remain above entry but before target
function isRunningCondition(alert, previous, ltp) {
  return previous < alert.entry_price && ltp >= alert.entry_price;
}

// Near Entry: within 1.5% of entry, but not yet hit entry
function isNearEntry(alert, ltp) {
  const diffPercent = Math.abs(ltp - alert.entry_price) / alert.entry_price * 100;
  return ltp < alert.entry_price && diffPercent <= 1.5;
}

// ------------------- Queue Setup -------------------
const alertQueue = new Bull("alert-processing", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  limiter: { max: 1000, duration: 1000 }, // rate limit
});

// ------------------- Queue Processor -------------------
alertQueue.process(async (job) => {
  const { symbol, tick } = job.data;
  const ltp =
    tick?.fullFeed?.marketFF?.ltpc?.ltp ??
    tick?.fullFeed?.indexFF?.ltpc?.ltp;

  if (!ltp) return;

  // Get active alerts from DB
  const alerts = await Alert.find({
    instrument_key: symbol,
    status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
  }).populate("user");

  for (const alert of alerts) {
    const user = alert.user;
    if (!user || !user.email) continue;

    const previous = alert.last_ltp ?? alert.cmp ?? (alert.stop_loss - 1);
    let newStatus = alert.status ?? STATUSES.PENDING;
    const oldStatus = alert.status;

    // ------------------- Check rules -------------------

    if (isSlHit(alert, ltp)) {
      newStatus = STATUSES.SL_HIT;
    } else if (isTargetHit(alert, ltp)) {
      newStatus = STATUSES.TARGET_HIT;
    } else {
      if (oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) {
        // Once entered, keep Running if still valid
        if (ltp >= alert.entry_price && ltp < alert.target_price && ltp > alert.stop_loss) {
          newStatus = STATUSES.RUNNING;
        } else {
          newStatus = oldStatus; // stay
        }
      } else {
        if (isRunningCondition(alert, previous, ltp)) {
          newStatus = STATUSES.RUNNING;
        } else if (isEnterCondition(alert, ltp)) {
          newStatus = STATUSES.ENTER;
        } else if (isNearEntry(alert, ltp)) {
          newStatus = STATUSES.NEAR_ENTRY;
        } else {
          newStatus = STATUSES.PENDING;
        }
      }
    }

    // Skip if nothing changed
    if (newStatus === alert.status && alert.last_ltp === ltp) continue;

    // Save new status
    alert.status = newStatus;
    alert.last_ltp = ltp;
    await alert.save();

    // ------------------- Notifications -------------------

    const emailTriggerStatuses = [
      STATUSES.SL_HIT,
      STATUSES.TARGET_HIT,
      STATUSES.ENTER,
      STATUSES.RUNNING,
    ];

    if (emailTriggerStatuses.includes(newStatus) && newStatus !== oldStatus) {
      try {
        const alertDetails = {
          trading_symbol: alert.trading_symbol,
          status: newStatus,
          current_price: ltp,
          entry_price: alert.entry_price,
          stop_loss: alert.stop_loss,
          target_price: alert.target_price,
          trade_type: alert.trade_type,
          triggered_at: new Date(),
        };
        await emailService.sendAlertNotification(user.email, alertDetails);
        console.log(`📧 Email sent for alert ${alert._id} to ${user.email}`);
      } catch (error) {
        console.error(`❌ Failed to send email for alert ${alert._id}:`, error);
      }
    }

    // Push notification
    try {
      if (user.deviceToken) {
        await admin.messaging().send({
          token: user.deviceToken,
          notification: {
            title: "Alert Triggered",
            body: `Symbol: ${symbol} at price ${ltp} - Status: ${newStatus}`,
          },
        });
      }
    } catch (err) {
      console.error("Push notification failed:", err);
    }

    // Socket.io live update
    const io = ioInstance.getIo();
    if (io) {
      io.to(`user:${user._id.toString()}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltp,
        timestamp: new Date().toISOString(),
      });

      if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus)) {
        io.to(`user:${user._id.toString()}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          price: ltp,
          status: newStatus,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
});

// ------------------- Queue Cleanup -------------------
setInterval(async () => {
  await alertQueue.clean(10000, "completed");
  await alertQueue.clean(10000, "failed");
  await alertQueue.clean(10000, "wait");
  await alertQueue.clean(10000, "active");
  console.log("Alert queue cleaned");
}, 10000);

// ------------------- Migration -------------------
async function migrateAlerts() {
  const alerts = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    await alert.save();
  }
  console.log(`Migrated ${alerts.length} alerts to pending.`);
}

module.exports = {
  migrateAlerts,
  STATUSES,
};
