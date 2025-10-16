// services/tickProcessor.js - REFACTORED & OPTIMIZED

const Queue = require('bull');
const config = require("../config/config");
const Alert = require("../models/Alert");
const User = require("../models/User");
const redisService = require("./redisService");
const { STATUSES } = require("./socketService");

const tickQueue = new Queue('tick-processing', {
  redis: { 
    host: config.redisHost, 
    port: config.redisPort, 
    password: config.redisPassword 
  },
  limiter: { max: 500, duration: 1000 },
  settings: { 
    maxStalledCount: 2, 
    stalledInterval: 5000, 
    lockDuration: 30000 
  }
});

// FIX: Use Map with size limit to prevent memory leak
const lastProcessed = new Map();
const MAX_CACHE_SIZE = 10000;

function updateLastProcessed(symbol) {
  if (lastProcessed.size >= MAX_CACHE_SIZE) {
    const firstKey = lastProcessed.keys().next().value;
    lastProcessed.delete(firstKey);
  }
  lastProcessed.set(symbol, Date.now());
}

tickQueue.process(async (job) => {
  const { symbol, ltp } = job.data;
  if (ltp == null) return;

  const now = Date.now();
  const lastTime = lastProcessed.get(symbol);
  
  if (lastTime && now - lastTime < 1000) return;
  
  updateLastProcessed(symbol);

  const users = await redisService.getStockUsers(symbol);
  
  for (const userIdStr of users) {
    const alerts = await Alert.find({
      user: userIdStr,
      instrument_key: symbol,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    }).lean();

    for (const alert of alerts) {
      const isBullish = alert.trend === "bullish";
      let triggered = false;
      let newStatus = alert.status;

      if (isBullish) {
        if (ltp >= alert.target_price) {
          triggered = true;
          newStatus = STATUSES.TARGET_HIT;
        } else if (ltp <= alert.stop_loss) {
          triggered = true;
          newStatus = STATUSES.SL_HIT;
        }
      } else {
        if (ltp <= alert.target_price) {
          triggered = true;
          newStatus = STATUSES.TARGET_HIT;
        } else if (ltp >= alert.stop_loss) {
          triggered = true;
          newStatus = STATUSES.SL_HIT;
        }
      }

      if (triggered) {
        await Alert.updateOne({ _id: alert._id }, { status: newStatus });
      }
    }
  }
});

// Optimized cleanup with parallel operations
setInterval(async () => {
  try {
    await Promise.all([
      tickQueue.clean(10000, 'completed'),
      tickQueue.clean(10000, 'failed'),
      tickQueue.clean(10000, 'wait'),
      tickQueue.clean(10000, 'active')
    ]);
    console.log('✅ Tick queue cleaned');
  } catch (error) {
    console.error('❌ Tick queue cleanup error:', error.message);
  }
}, 10000);

module.exports = tickQueue;
