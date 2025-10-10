const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const emailQueue = require("../queues/emailQueue");
const telegramQueue = require("../queues/telegramQueue"); // NEW
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
  return ltp < alert.entry_price && ltp > alert.stop_loss;
}

function bullishRunningCondition(alert, previous, ltp) {
  return previous < alert.entry_price && ltp >= alert.entry_price;
}

function bullishNearEntry(alert, ltp) {
  const diffPercent = ((ltp - alert.entry_price) / alert.entry_price) * 100;
  return ltp > alert.entry_price && diffPercent <= 1;
}

function bullishStillRunning(alert, ltp) {
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
  return ltp > alert.entry_price && ltp < alert.stop_loss;
}

function bearishRunningCondition(alert, previous, ltp) {
  return previous > alert.entry_price && ltp <= alert.entry_price;
}

function bearishNearEntry(alert, ltp) {
  const diffPercent = ((alert.entry_price - ltp) / alert.entry_price) * 100;
  return ltp < alert.entry_price && diffPercent <= 1;
}

function bearishStillRunning(alert, ltp) {
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

// ------------------- QUEUE PROCESSOR -------------------
alertQueue.process(async (job) => {
  const { symbol, tick } = job.data;
  const ltp =
    tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;

  if (!ltp) return;

  const alerts = await Alert.find({
    instrument_key: symbol,
    status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
  }).populate("user");

  for (const alert of alerts) {
    const user = alert.user;
    if (!user || !user.email) continue;

    const previous = alert.last_ltp ?? alert.cmp ?? alert.entry_price;
    let newStatus = alert.status ?? STATUSES.PENDING;
    const oldStatus = alert.status;
    let entryCrossedUpdated = alert.entry_crossed || false;

    // ------------------- STATUS DETERMINATION LOGIC -------------------

    if (isSlHit(alert, ltp)) {
      newStatus = STATUSES.SL_HIT;
    } else if (isTargetHit(alert, ltp) && entryCrossedUpdated) {
      newStatus = STATUSES.TARGET_HIT;
    } else {
      if (isEnterCondition(alert, ltp) && !entryCrossedUpdated) {
        newStatus = STATUSES.ENTER;
        entryCrossedUpdated = true;
        console.log(`🎯 FIRST TIME Entry crossed for ${alert.trading_symbol} at ₹${ltp}`);
      } else if (entryCrossedUpdated && isRunningCondition(alert, previous, ltp)) {
        newStatus = STATUSES.RUNNING;
      } else if ((oldStatus === STATUSES.ENTER || oldStatus === STATUSES.RUNNING) && entryCrossedUpdated) {
        if (isStillRunning(alert, ltp)) {
          newStatus = STATUSES.RUNNING;
        } else if (isEnterCondition(alert, ltp)) {
          newStatus = STATUSES.RUNNING;
        } else {
          newStatus = oldStatus;
        }
      } else if (isNearEntry(alert, ltp) && !entryCrossedUpdated) {
        newStatus = STATUSES.NEAR_ENTRY;
      } else {
        newStatus = STATUSES.PENDING;
      }
    }

    if (newStatus === alert.status && alert.last_ltp === ltp && entryCrossedUpdated === alert.entry_crossed) {
      continue;
    }

    alert.status = newStatus;
    alert.last_ltp = ltp;
    alert.entry_crossed = entryCrossedUpdated;
    await alert.save();

    if (newStatus !== oldStatus) {
      console.log(`📊 ${alert.trading_symbol}: ${oldStatus} → ${newStatus} at ₹${ltp} (Entry crossed: ${entryCrossedUpdated})`);
    }

    // ------------------- NOTIFICATIONS -------------------

    const emailTriggerStatuses = [
      STATUSES.SL_HIT,
      STATUSES.TARGET_HIT,
      STATUSES.ENTER,
    ];

    if (emailTriggerStatuses.includes(newStatus) && newStatus !== oldStatus) {
      
      // ------------------- EMAIL NOTIFICATION (QUEUE-BASED) -------------------
      emailQueue.add(
        {
          userEmail: user.email,
          alertDetails: {
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
          },
        },
        {
          priority: newStatus === STATUSES.SL_HIT || newStatus === STATUSES.TARGET_HIT ? 1 : 2,
          removeOnComplete: true,
          removeOnFail: false,
        }
      ).then(() => {
        console.log(`📧 Email queued for ${alert.trading_symbol} to ${user.email} - Status: ${newStatus}`);
      }).catch((error) => {
        console.error(`❌ Failed to queue email for alert ${alert._id}:`, error.message);
      });

      // ------------------- FIREBASE PUSH NOTIFICATION -------------------
      (async () => {
        try {
          if (user.deviceToken) {
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
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                url: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts',
              },
              webpush: {
                fcmOptions: {
                  link: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts',
                },
                notification: {
                  icon: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico',
                  badge: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico',
                  tag: `${alert._id}_${newStatus}`,
                  requireInteraction: false,
                }
              },
              android: {
                priority: notifConfig.priority,
                notification: {
                  channelId: 'stock_alerts',
                  priority: 'high',
                  sound: 'default',
                  tag: `${alert._id}_${newStatus}`,
                  clickAction: 'https://stock-notify-frontend-dev.vercel.app/dashboard/alerts',
                  icon: 'notification_icon',
                  color: '#1976d2',
                }
              },
              apns: {
                payload: {
                  aps: {
                    sound: 'default',
                    badge: 1,
                    alert: {
                      title: notifConfig.title,
                      body: notifConfig.body,
                    },
                    'thread-id': alert._id.toString(),
                    'category': 'STOCK_ALERT_CATEGORY',
                  }
                },
                fcmOptions: {
                  imageUrl: 'https://stock-notify-frontend-dev.vercel.app/favicon.ico',
                }
              },
            });
            
            console.log(`✅ 🔔 Firebase notification sent for ${alert.trading_symbol} - Status: ${newStatus}`);
          }
        } catch (err) {
          console.error(`❌ Firebase push notification failed for alert ${alert._id}:`, err.message);
        }
      })();

      // =============== NEW: TELEGRAM NOTIFICATION (QUEUE-BASED) ===============
      if (user.telegramChatId && user.telegramEnabled) {
        telegramQueue.add(
          {
            chatId: user.telegramChatId,
            alertDetails: {
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
            },
          },
          {
            priority: newStatus === STATUSES.SL_HIT || newStatus === STATUSES.TARGET_HIT ? 1 : 2,
            removeOnComplete: true,
            removeOnFail: false,
            attempts: 3,
            backoff: {
              type: 'exponential',
              delay: 2000
            }
          }
        ).then(() => {
          console.log(`📱 Telegram queued for ${alert.trading_symbol} to chat ${user.telegramChatId} - Status: ${newStatus}`);
        }).catch((error) => {
          console.error(`❌ Failed to queue Telegram for alert ${alert._id}:`, error.message);
        });
      }
    }

    // ------------------- SOCKET.IO LIVE UPDATE -------------------
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
  const alerts = await Alert.find({
    status: { $nin: Object.values(STATUSES) },
  });
  for (const alert of alerts) {
    alert.status = STATUSES.PENDING;
    alert.last_ltp = null;
    alert.entry_crossed = false;
    await alert.save();
  }
  
  const enteredAlerts = await Alert.find({
    status: { $in: [STATUSES.ENTER, STATUSES.RUNNING, STATUSES.TARGET_HIT] }
  });
  for (const alert of enteredAlerts) {
    if (!alert.entry_crossed) {
      alert.entry_crossed = true;
      await alert.save();
    }
  }
  
  const alertsWithoutField = await Alert.find({
    entry_crossed: { $exists: false }
  });
  for (const alert of alertsWithoutField) {
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
  alertQueue, // Export for external use if needed
};
