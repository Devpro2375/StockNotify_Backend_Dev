// queues/alertQueue.js
// Single shared Bull queue for alert processing.
// Both the producer (upstoxService) and consumer (alertService) import from here.

const Bull = require("bull");
const config = require("../config/config");

const alertQueue = new Bull("alert-processing", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  limiter: { max: 2000, duration: 1000 },
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1, // ticks are ephemeral — no retry needed
  },
});

alertQueue.on("error", (err) => {
  // Suppress MISCONF spam
  if (String(err.message).includes('MISCONF')) return;
  console.error("❌ Alert queue error:", err.message);
});

// Aggressive cleanup — every 5 minutes
setInterval(async () => {
  try {
    await alertQueue.clean(30 * 60 * 1000, "completed");  // 30 minutes
    await alertQueue.clean(2 * 60 * 60 * 1000, "failed");  // 2 hours
  } catch (err) {
    if (!String(err.message).includes('MISCONF')) {
      console.error("❌ Alert queue cleanup error:", err.message);
    }
  }
}, 5 * 60 * 1000);

module.exports = alertQueue;
