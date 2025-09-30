const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailService = require("../utils/email");
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

// ------------------- BULLISH HELPER FUNCTIONS -------------------

function bullishSlHit(alert, ltp) {
  return ltp <= alert.stop_loss;
}

function bullishTargetHit(alert, ltp) {
  return ltp >= alert.target_price;
}

function bullishEnterCondition(alert, ltp) {
  // Entered: LTP goes BELOW entry price (but still above SL)
  return ltp < alert.entry_price && ltp > alert.stop_loss;
}

function bullishRunningCondition(alert, previous, ltp) {
  // After being below entry once, if LTP crosses back above entry
  return previous < alert.entry_price && ltp >= alert.entry_price;
}

function bullishNearEntry(alert, ltp) {
  // Within 1% ABOVE entry, but not yet entered
  const diffPercent = ((ltp - alert.entry_price) / alert.entry_price) * 100;
  return ltp > alert.entry_price && diffPercent <= 1;
}

// ------------------- BEARISH HELPER FUNCTIONS -------------------

function bearishSlHit(alert, ltp) {
  return ltp >= alert.stop_loss;
}

function bearishTargetHit(alert, ltp) {
  return ltp <= alert.target_price;
}

function bearishEnterCondition(alert, ltp) {
  // Entered: LTP goes ABOVE entry price (but still below SL)
  return ltp > alert.entry_price && ltp < alert.stop_loss;
}

function bearishRunningCondition(alert, previous, ltp) {
  // After being above entry once, if LTP crosses back below entry
  return previous > alert.entry_price && ltp <= alert.entry_price;
}

function bearishNearEntry(alert, ltp) {
  // Within 1% BELOW entry, but not yet entered
  const diffPercent = ((alert.entry_price - ltp) / alert.entry_price) * 100;
  return ltp < alert.entry_price && diffPercent <= 1;
}

// ------------------- UNIFIED HELPER FUNCTIONS -------------------

function isSlHit(alert, ltp) {
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    return bearishSlHit(alert, ltp);
  }
  return bullishSlHit(alert, ltp);
}

function isTargetHit(alert, ltp) {
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    return bearishTargetHit(alert, ltp);
  }
  return bullishTargetHit(alert, ltp);
}

function isEnterCondition(alert, ltp) {
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    return bearishEnterCondition(alert, ltp);
  }
  return bullishEnterCondition(alert, ltp);
}

function isRunningCondition(alert, previous, ltp) {
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    return bearishRunningCondition(alert, previous, ltp);
  }
  return bullishRunningCondition(alert, previous, ltp);
}

function isNearEntry(alert, ltp) {
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    return bearishNearEntry(alert, ltp);
  }
  return bullishNearEntry(alert, ltp);
}

function isStillRunning(alert, ltp) {
  // Check if position should remain in RUNNING state
  if (alert.trade_type === TRADE_TYPES.BEARISH) {
    // Bearish: still running if between target and SL (not hit either)
    return ltp > alert.target_price && ltp < alert.stop_loss;
  } else {
    // Bullish: still running if between entry and target (and above SL)
    return ltp >= alert.entry_price && ltp < alert.target_price && ltp > alert.stop_loss;
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
});

// ------------------- QUEUE PROCESSOR -------------------
alertQueue.process(async (job) => {
  const { symbol, tick } = job.data;
  const ltp =
    tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;

  if (!ltp) return;

  // Get active alerts from DB
  const alerts = await Alert.find({
    instrument_key: symbol,
    status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
  }).populate("user");

  for (const alert of alerts) {
    const user = alert.user;
    if (!user || !user.email) continue;

    // Determine previous price for comparison
    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    let newStatus = alert.status ?? STATUSES.PENDING;
    const oldStatus = alert.status;

    // ------------------- STATUS DETERMINATION LOGIC -------------------

    // Priority 1: Check terminal states first
    if (isSlHit(alert, ltp)) {
      newStatus = STATUSES.SL_HIT;
    } else if (isTargetHit(alert, ltp)) {
      newStatus = STATUSES.TARGET_HIT;
    } else {
      // Priority 2: Handle ENTER and RUNNING states
      if (oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) {
        // Once entered, check if still running
        if (isStillRunning(alert, ltp)) {
          newStatus = STATUSES.RUNNING;
        } else if (isRunningCondition(alert, previous, ltp)) {
          // Transition from ENTER to RUNNING
          newStatus = STATUSES.RUNNING;
        } else {
          // Stay in current state if conditions not met
          newStatus = oldStatus;
        }
      } else {
        // Priority 3: Check for new entry or near-entry
        if (isRunningCondition(alert, previous, ltp)) {
          // Price crossed entry threshold - immediately RUNNING
          newStatus = STATUSES.RUNNING;
        } else if (isEnterCondition(alert, ltp)) {
          // Price in entry zone
          newStatus = STATUSES.ENTER;
        } else if (isNearEntry(alert, ltp)) {
          // Price approaching entry
          newStatus = STATUSES.NEAR_ENTRY;
        } else {
          // No conditions met
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

    // ------------------- NOTIFICATIONS -------------------

    const emailTriggerStatuses = [
      STATUSES.SL_HIT,
      STATUSES.TARGET_HIT,
      STATUSES.ENTER,
    ];

    // Send email only on status CHANGE and for trigger statuses
    if (
      emailTriggerStatuses.includes(newStatus) &&
      newStatus !== oldStatus
    ) {
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
        console.log(`📧 Email sent for alert ${alert._id} to ${user.email} - Status: ${newStatus}`);
      } catch (error) {
        console.error(`❌ Failed to send email for alert ${alert._id}:`, error);
      }
    }

    // Push notification (only on status change)
    if (newStatus !== oldStatus) {
      try {
        if (user.deviceToken) {
          await admin.messaging().send({
            token: user.deviceToken,
            notification: {
              title: `Alert: ${newStatus.toUpperCase()}`,
              body: `${alert.trading_symbol} at ₹${ltp} - ${alert.trade_type.toUpperCase()} position`,
            },
            data: {
              alertId: alert._id.toString(),
              status: newStatus,
              symbol: symbol,
              price: ltp.toString(),
            },
          });
        }
      } catch (err) {
        console.error("Push notification failed:", err);
      }
    }

    // Socket.io live update (emit on every price/status change)
    const io = ioInstance.getIo();
    if (io) {
      io.to(`user:${user._id.toString()}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltp,
        trade_type: alert.trade_type,
        timestamp: new Date().toISOString(),
      });

      // Special event for terminal states
      if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) && newStatus !== oldStatus) {
        io.to(`user:${user._id.toString()}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          price: ltp,
          status: newStatus,
          trade_type: alert.trade_type,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
});

// ------------------- QUEUE CLEANUP -------------------
setInterval(async () => {
  await alertQueue.clean(10000, "completed");
  await alertQueue.clean(10000, "failed");
  await alertQueue.clean(10000, "wait");
  await alertQueue.clean(10000, "active");
  console.log("✅ Alert queue cleaned");
}, 10000);

// ------------------- MIGRATION -------------------
async function migrateAlerts() {
  const alerts = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    await alert.save();
  }
  console.log(`✅ Migrated ${alerts.length} alerts to pending.`);
}

module.exports = {
  migrateAlerts,
  STATUSES,
  TRADE_TYPES,
};
