// services/tickProcessor.js

const Queue = require('bull');
const admin = require('firebase-admin');
const config = require("../config/config");
const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const { STATUSES } = require("./socketService");

admin.initializeApp({
  credential: admin.credential.cert(config.firebaseServiceAccount)
});

const tickQueue = new Queue('tick-processing', {
  redis: { host: config.redisHost, port: config.redisPort, password: config.redisPassword },
  limiter: { max: 500, duration: 1000 },
  settings: { maxStalledCount: 2, stalledInterval: 5000, lockDuration: 30000 }
});

let lastProcessed = {};

tickQueue.process(async (job) => {
  const { symbol, ltp } = job.data;
  if (ltp === null || ltp === undefined) return;

  const now = Date.now();
  if (lastProcessed[symbol] && now - lastProcessed[symbol] < 1000) return;
  lastProcessed[symbol] = now;

  const users = await redisService.getStockUsers(symbol);
  for (const userIdStr of users) {
    const userId = userIdStr;
    const alerts = await Alert.find({
      user: userId,
      instrument_key: symbol,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });
    for (const alert of alerts) {
      const price = ltp;

      let triggered = false;
      if (alert.trend === "bullish") {
        if (price >= alert.target_price) triggered = true;
        else if (price <= alert.stop_loss) triggered = true;
      } else if (alert.trend === "bearish") {
        if (price <= alert.target_price) triggered = true;
        else if (price >= alert.stop_loss) triggered = true;
      }

      if (triggered) {
        const newStatus = (price <= alert.stop_loss) ? STATUSES.SL_HIT : STATUSES.TARGET_HIT;
        await Alert.updateOne({ _id: alert._id }, { status: newStatus });

        const user = await User.findById(userId);
        // if (user && user.deviceToken) {
        //   try {
        //     await admin.messa.ging().send({
        //       token: user.deviceToken,
        //       notification: {
        //         title: 'Alert Triggered',
        //         body: `Symbol: ${symbol} at price ${price} - Status: ${newStatus}`
        //       }
        //     });
        //   } catch (err) {
        //     console.error('Push notification failed:', err);
        //   }
        // }
      }
    }
  }
});

setInterval(async () => {
  await tickQueue.clean(10000, 'completed');
  await tickQueue.clean(10000, 'failed');
  await tickQueue.clean(10000, 'wait');
  await tickQueue.clean(10000, 'active');
  console.log('Bull queue cleaned');
}, 10000);
