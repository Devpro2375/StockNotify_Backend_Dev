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
    removeOnComplete: 50,
    removeOnFail: 200,
    attempts: 1, // ticks are ephemeral — no retry needed
  },
});

alertQueue.on("error", (err) => {
  console.error("❌ Alert queue error:", err.message);
});

// Periodic cleanup — every 10 minutes
setInterval(async () => {
  try {
    await alertQueue.clean(60 * 60 * 1000, "completed");
    await alertQueue.clean(60 * 60 * 1000, "failed");
  } catch (err) {
    console.error("❌ Alert queue cleanup error:", err.message);
  }
}, 10 * 60 * 1000);

module.exports = alertQueue;
