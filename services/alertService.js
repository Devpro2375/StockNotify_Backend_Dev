const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailService = require("../utils/email");

// Constants for statuses
const STATUSES = {
  PENDING: "pending",
  NEAR_ENTRY: "nearEntry",
  ENTER: "enter",
  RUNNING: "running",
  SL_HIT: "slHit",
  TARGET_HIT: "targetHit",
};

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

// Updated function with email notifications and bug fixes
async function updateAlertStatus(symbol, tick, io) {
  const ltp = tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;
  if (!ltp) {
    console.log(`No LTP for ${symbol}, skipping update.`);
    return;
  }

  const userIds = await redisService.getStockUsers(symbol);
//   console.log(`Updating statuses for ${symbol} with LTP ${ltp} for users: ${userIds.join(', ')}`);

  for (const userId of userIds) {
    const alerts = await Alert.find({
      user: userId,
      instrument_key: symbol,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });

    for (const alert of alerts) {
      const previous = alert.last_ltp ?? alert.cmp ?? (alert.stop_loss - 1);
      let newStatus = alert.status ?? STATUSES.PENDING;
      const oldStatus = alert.status;

      if (isSlHit(alert, ltp)) {
        newStatus = STATUSES.SL_HIT;
      } else if ([STATUSES.ENTER, STATUSES.RUNNING].includes(alert.status) && isTargetHit(alert, ltp)) {
        newStatus = STATUSES.TARGET_HIT;
      } else if (alert.status === STATUSES.ENTER && isCrossToRunning(alert, previous, ltp)) {
        newStatus = STATUSES.RUNNING;
        console.log(`Triggered running for alert ${alert._id}: Cross detected from ${previous} to ${ltp} after enter.`);
      } else if (![STATUSES.RUNNING].includes(newStatus) && isEnterCondition(alert, ltp)) {
        newStatus = STATUSES.ENTER;
      } else if (![STATUSES.ENTER, STATUSES.RUNNING].includes(newStatus) && isNearEntry(alert, ltp)) {
        newStatus = STATUSES.NEAR_ENTRY;
      } else {
        newStatus = STATUSES.PENDING;
      }

      if (newStatus === alert.status && alert.last_ltp === ltp) continue;

      alert.status = newStatus;
      alert.last_ltp = ltp;
      await alert.save();

    //   console.log(`Updated alert ${alert._id} to status ${newStatus} at LTP ${ltp}.`);

      io.to(`user:${userId}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltp,
        timestamp: new Date().toISOString(),
      });

      const emailTriggerStatuses = [STATUSES.SL_HIT, STATUSES.TARGET_HIT, STATUSES.ENTER, STATUSES.RUNNING];
      if (emailTriggerStatuses.includes(newStatus) && newStatus !== oldStatus) {
        try {
          const user = await User.findById(userId);
          if (user && user.email) {
            const alertDetails = {
              trading_symbol: alert.trading_symbol,
              status: newStatus,
              current_price: ltp,
              entry_price: alert.entry_price,
              stop_loss: alert.stop_loss,
              target_price: alert.target_price,
              trend: alert.trend,
              trade_type: alert.trade_type,
              triggered_at: new Date()
            };

            emailService.sendAlertNotification(user.email, alertDetails)
              .then(() => console.log(`📧 Email sent for alert ${alert._id} to ${user.email}`))
              .catch(error => console.error(`❌ Failed to send email for alert ${alert._id}:`, error));
          }
        } catch (error) {
          console.error(`Error preparing email notification for alert ${alert._id}:`, error);
        }
      }

      if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus)) {
        io.to(`user:${userId}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          price: ltp,
          status: newStatus,
          timestamp: new Date().toISOString(),
        });
      }
    }
  }
}

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

module.exports = {
  updateAlertStatus,
  migrateAlerts,
  STATUSES
};
