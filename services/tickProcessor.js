const Queue = require('bull');
const admin = require('firebase-admin');
const config = require("../config/config");
const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");

// Initialize Firebase
admin.initializeApp({
  credential: admin.credential.cert(config.firebaseServiceAccount)
});

// Tick queue with optimizations
const tickQueue = new Queue('tick-processing', {
  redis: { host: config.redisHost, port: config.redisPort, password: config.redisPassword },
  limiter: { max: 500, duration: 1000 }, // Limit to 500 jobs/sec to prevent overload
  settings: { maxStalledCount: 2, stalledInterval: 5000, lockDuration: 30000 } // Handle stalls gracefully
});

// Processor with debouncing
let lastProcessed = {};
tickQueue.process(async (job) => {
  const { symbol, tick } = job.data;
  const now = Date.now();
  if (lastProcessed[symbol] && now - lastProcessed[symbol] < 1000) return; // Debounce to 1/sec per symbol
  lastProcessed[symbol] = now;

  const users = await redisService.getStockUsers(symbol);
  for (const userIdStr of users) {
    const userId = userIdStr;
    const alerts = await Alert.find({
      user: userId,
      instrument_key: symbol,
      status: "active",
    });
    for (const alert of alerts) {
      const price =
        tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp;
      if (!price) continue;

      let triggered = false;
      if (alert.trend === "bullish") {
        if (price >= alert.target_price) triggered = true;
        else if (price <= alert.stop_loss) triggered = true;
      } else if (alert.trend === "bearish") {
        if (price <= alert.target_price) triggered = true;
        else if (price >= alert.stop_loss) triggered = true;
      }

      if (triggered) {
        await Alert.updateOne({ _id: alert._id }, { status: "triggered" });

        // Send push notification (persistent even if app closed)
        const user = await User.findById(userId);
        if (user && user.deviceToken) {
          try {
            await admin.messaging().send({
              token: user.deviceToken,
              notification: {
                title: 'Alert Triggered',
                body: `Symbol: ${symbol} at price ${price}`
              }
            });
          } catch (err) {
            console.error('Push notification failed:', err);
          }
        }
      }
    }
  }
});

// Increase frequency and scope
setInterval(async () => {
  await tickQueue.clean(10000, 'completed'); // Clean completed jobs older than 10 seconds
  await tickQueue.clean(10000, 'failed');
  await tickQueue.clean(10000, 'wait'); // Also clean waiting jobs if needed
  await tickQueue.clean(10000, 'active'); // Clean active (potentially stalled)
  console.log('Bull queue cleaned'); // Log for monitoring
}, 10000); // Every 10 seconds
