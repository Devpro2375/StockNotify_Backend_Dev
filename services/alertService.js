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

// ------------------- NOTIFICATION TRIGGER STATUSES -------------------
// CRITICAL: Only these statuses should trigger notifications
const NOTIFICATION_TRIGGER_STATUSES = [
  STATUSES.SL_HIT,
  STATUSES.TARGET_HIT,
  STATUSES.ENTER,
];

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

function bullishStillRunning(alert, ltp) {
  // Still running if between entry and target (and above SL)
  return ltp >= alert.entry_price && ltp < alert.target_price && ltp > alert.stop_loss;
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

function bearishStillRunning(alert, ltp) {
  // Still running if between target and SL (not hit either)
  return ltp > alert.target_price && ltp < alert.stop_loss;
}

// ------------------- UNIFIED HELPER FUNCTIONS -------------------

function isSlHit(alert, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishSlHit(alert, ltp);
  }
  return bullishSlHit(alert, ltp);
}

function isTargetHit(alert, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishTargetHit(alert, ltp);
  }
  return bullishTargetHit(alert, ltp);
}

function isEnterCondition(alert, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishEnterCondition(alert, ltp);
  }
  return bullishEnterCondition(alert, ltp);
}

function isRunningCondition(alert, previous, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishRunningCondition(alert, previous, ltp);
  }
  return bullishRunningCondition(alert, previous, ltp);
}

function isNearEntry(alert, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishNearEntry(alert, ltp);
  }
  return bullishNearEntry(alert, ltp);
}

function isStillRunning(alert, ltp) {
  if (alert.trend === TRADE_TYPES.BEARISH) {
    return bearishStillRunning(alert, ltp);
  }
  return bullishStillRunning(alert, ltp);
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

// ------------------- NOTIFICATION TRACKING -------------------
// Track which alerts have already sent notifications for specific statuses
// Key format: `alertId_status` -> timestamp
const notificationHistory = new Map();

// Clean up old notification history entries every 30 minutes
setInterval(() => {
  const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
  for (const [key, timestamp] of notificationHistory.entries()) {
    if (timestamp < thirtyMinutesAgo) {
      notificationHistory.delete(key);
    }
  }
}, 30 * 60 * 1000);

// Helper function to check if notification was already sent
function hasNotificationBeenSent(alertId, status) {
  const key = `${alertId}_${status}`;
  return notificationHistory.has(key);
}

// Helper function to mark notification as sent
function markNotificationAsSent(alertId, status) {
  const key = `${alertId}_${status}`;
  notificationHistory.set(key, Date.now());
  console.log(`📝 Marked notification as sent: ${key}`);
}

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
    let entryCrossedUpdated = alert.entry_crossed || false;

    // ------------------- STATUS DETERMINATION LOGIC -------------------

    // Priority 1: Check SL Hit first (can happen anytime, terminal state)
    if (isSlHit(alert, ltp)) {
      newStatus = STATUSES.SL_HIT;
    } 
    // Priority 2: Check Target Hit ONLY if entry was crossed
    else if (isTargetHit(alert, ltp) && entryCrossedUpdated) {
      newStatus = STATUSES.TARGET_HIT;
    } 
    // Priority 3: Handle entry and running states
    else {
      // CRITICAL STOCK MARKET LOGIC:
      // Once entry is crossed (entry_crossed = true), ENTER status can only be triggered ONCE
      // After that, price movements only affect RUNNING status, not ENTER status
      
      // Check if currently entering (crossing entry zone) - ONLY if entry hasn't been crossed before
      if (isEnterCondition(alert, ltp) && !entryCrossedUpdated) {
        newStatus = STATUSES.ENTER;
        // Mark entry as crossed - THIS HAPPENS ONLY ONCE IN ALERT LIFECYCLE
        entryCrossedUpdated = true;
        console.log(`🎯 FIRST TIME Entry crossed for ${alert.trading_symbol} at ₹${ltp}`);
      } 
      // Check if transitioning to running (after entry was crossed)
      else if (entryCrossedUpdated && isRunningCondition(alert, previous, ltp)) {
        newStatus = STATUSES.RUNNING;
      }
      // Maintain enter/running state if already entered
      else if ((oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) && entryCrossedUpdated) {
        // Check if still in running range
        if (isStillRunning(alert, ltp)) {
          newStatus = STATUSES.RUNNING;
        } 
        // If price comes back to entry zone, maintain RUNNING (not ENTER again)
        else if (isEnterCondition(alert, ltp)) {
          newStatus = STATUSES.RUNNING; // FIXED: Don't go back to ENTER
        } 
        else {
          // Maintain current state if no other conditions met
          newStatus = oldStatus;
        }
      }
      // Check near entry (only if entry not crossed yet)
      else if (isNearEntry(alert, ltp) && !entryCrossedUpdated) {
        newStatus = STATUSES.NEAR_ENTRY;
      } 
      // Default to pending if no conditions met
      else {
        newStatus = STATUSES.PENDING;
      }
    }

    // Skip if nothing changed
    if (newStatus === alert.status && alert.last_ltp === ltp && entryCrossedUpdated === alert.entry_crossed) {
      continue;
    }

    // Save new status and entry_crossed flag
    alert.status = newStatus;
    alert.last_ltp = ltp;
    alert.entry_crossed = entryCrossedUpdated;
    await alert.save();

    // Log status change
    if (newStatus !== oldStatus) {
      console.log(`📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltp} (Entry crossed: ${entryCrossedUpdated})`);
    }

    // ------------------- NOTIFICATIONS -------------------
    // CRITICAL: Only trigger notifications for specific status changes AND first time only
    const shouldNotify = 
      NOTIFICATION_TRIGGER_STATUSES.includes(newStatus) && 
      newStatus !== oldStatus &&
      !hasNotificationBeenSent(alert._id, newStatus); // PREVENT DUPLICATES

    if (shouldNotify) {
      // Mark this notification as sent IMMEDIATELY to prevent any race conditions
      markNotificationAsSent(alert._id, newStatus);

      const alertDetails = {
        trading_symbol: alert.trading_symbol,
        status: newStatus,
        current_price: ltp,
        entry_price: alert.entry_price,
        stop_loss: alert.stop_loss,
        target_price: alert.target_price,
        trend: alert.trend,
        trade_type: alert.trade_type,
        triggered_at: new Date(),
      };

      // ------------------- EMAIL NOTIFICATION -------------------
      (async () => {
        try {
          const result = await emailService.sendAlertNotification(user.email, alertDetails);
          console.log(`✅ 📧 Email sent for ${alert.trading_symbol} to ${user.email} - Status: ${newStatus} - MessageID: ${result.messageId}`);
        } catch (error) {
          console.error(`❌ Failed to send email for alert ${alert._id} to ${user.email}:`, error.message);
          if (process.env.NODE_ENV === 'production') {
            // Add your monitoring/logging service here (Sentry, LogRocket, etc.)
          }
        }
      })();

      // ------------------- FIREBASE PUSH NOTIFICATION WITH CLICK ACTION & ICON -------------------
      (async () => {
        try {
          if (user.deviceToken) {
            // Status-specific notification configuration
            const notificationConfig = {
              slHit: {
                title: '🛑 Stop Loss Hit',
                body: `${alert.trading_symbol} at ₹${ltp.toFixed(2)} - ${alert.trend.toUpperCase()}`,
                priority: 'high'
              },
              targetHit: {
                title: '🎯 Target Reached',
                body: `${alert.trading_symbol} at ₹${ltp.toFixed(2)} - ${alert.trend.toUpperCase()}`,
                priority: 'high'
              },
              enter: {
                title: '🚀 Entry Condition Met',
                body: `${alert.trading_symbol} at ₹${ltp.toFixed(2)} - ${alert.trend.toUpperCase()}`,
                priority: 'high'
              }
            };

            const notifConfig = notificationConfig[newStatus] || notificationConfig.enter;

            await admin.messaging().send({
              token: user.deviceToken,
              notification: {
                title: notifConfig.title,
                body: notifConfig.body,
              },
              data: {
                alertId: alert._id.toString(),
                status: newStatus,
                symbol: symbol,
                trading_symbol: alert.trading_symbol,
                price: ltp.toString(),
                entry_price: alert.entry_price.toString(),
                stop_loss: alert.stop_loss.toString(),
                target_price: alert.target_price.toString(),
                trend: alert.trend,
                trade_type: alert.trade_type,
                entry_crossed: entryCrossedUpdated.toString(),
                timestamp: new Date().toISOString(),
                // CLICK ACTION: Redirect to alerts page
                click_action: 'FLUTTER_NOTIFICATION_CLICK', // For Flutter apps
                url: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts', // For web
              },
              // WEB PUSH CONFIGURATION WITH CLICK ACTION
              webpush: {
                fcmOptions: {
                  link: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts', // Web click redirect
                },
                notification: {
                  icon: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico', // Your favicon
                  badge: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico',
                  tag: `${alert._id}_${newStatus}`, // Prevents duplicates on web
                  requireInteraction: false,
                }
              },
              // ANDROID CONFIGURATION WITH CLICK ACTION & ICON
              android: {
                priority: notifConfig.priority,
                notification: {
                  channelId: 'stock_alerts',
                  priority: 'high',
                  sound: 'default',
                  tag: `${alert._id}_${newStatus}`, // Prevents duplicate notifications
                  clickAction: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts', // Android click redirect
                  icon: 'notification_icon', // Your app notification icon (must be in Android app)
                  color: '#1976d2', // Notification icon color
                }
              },
              // IOS (APNS) CONFIGURATION WITH CLICK ACTION
              apns: {
                payload: {
                  aps: {
                    sound: 'default',
                    badge: 1,
                    alert: {
                      title: notifConfig.title,
                      body: notifConfig.body,
                    },
                    'thread-id': alert._id.toString(), // Groups notifications on iOS
                    'category': 'STOCK_ALERT_CATEGORY', // For iOS action handling
                  }
                },
                fcmOptions: {
                  imageUrl: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico', // iOS notification image
                }
              },
            });
            
            console.log(`✅ 🔔 Firebase notification sent for ${alert.trading_symbol} - Status: ${newStatus} - Will redirect to alerts page on click`);
          }
        } catch (err) {
          console.error(`❌ Firebase push notification failed for alert ${alert._id}:`, err.message);
          // Don't throw - notification failure shouldn't block processing
        }
      })();
    }

    // ------------------- SOCKET.IO LIVE UPDATE -------------------
    // Socket updates happen on every price/status change (not just notifications)
    const io = ioInstance.getIo();
    if (io) {
      io.to(`user:${user._id.toString()}`).emit("alert_status_updated", {
        alertId: alert._id,
        status: newStatus,
        symbol,
        price: ltp,
        trade_type: alert.trade_type,
        trend: alert.trend,
        entry_crossed: entryCrossedUpdated,
        timestamp: new Date().toISOString(),
      });

      // Special event for terminal states (only on status change)
      if ([STATUSES.SL_HIT, STATUSES.TARGET_HIT].includes(newStatus) && newStatus !== oldStatus) {
        io.to(`user:${user._id.toString()}`).emit("alert_triggered", {
          alertId: alert._id,
          symbol,
          trading_symbol: alert.trading_symbol,
          price: ltp,
          status: newStatus,
          trade_type: alert.trade_type,
          trend: alert.trend,
          entry_crossed: entryCrossedUpdated,
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
  // Reset alerts with invalid statuses
  const alerts = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    alert.entry_crossed = false;
    await alert.save();
  }
  
  // Set entry_crossed for alerts already in ENTER, RUNNING, or TARGET_HIT states
  const enteredAlerts = await Alert.find({
    status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] }
  });
  for (const alert of enteredAlerts) {
    if (!alert.entry_crossed) {
      alert.entry_crossed = true;
      await alert.save();
    }
  }
  
  // Initialize entry_crossed field for alerts that don't have it
  const alertsWithoutField = await Alert.find({
    entry_crossed: { $exists: false }
  });
  for (const alert of alertsWithoutField) {
    // If status is ENTER, RUNNING, or TARGET_HIT, set to true, otherwise false
    alert.entry_crossed = [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT].includes(alert.status);
    await alert.save();
  }
  
  console.log(`✅ Migrated ${alerts.length} alerts to pending.`);
  console.log(`✅ Set entry_crossed for ${enteredAlerts.length} entered alerts.`);
  console.log(`✅ Initialized entry_crossed for ${alertsWithoutField.length} alerts.`);
}

module.exports = {
  migrateAlerts,
  STATUSES,
  TRADE_TYPES,
  NOTIFICATION_TRIGGER_STATUSES,
};
