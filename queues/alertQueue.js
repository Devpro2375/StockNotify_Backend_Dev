// queues/alertQueue.js
// ──────────────────────────────────────────────────────────────
// REFACTORED: Alert processing no longer uses Bull queue.
// Alerts are processed inline via setImmediate() in upstoxService.
// This file is kept for backward compatibility but the queue is
// no longer actively used for tick processing.
// Email and Telegram queues remain as Bull queues (they benefit
// from retry logic for external API calls).
// ──────────────────────────────────────────────────────────────

const Bull = require("bull");
const redisConfig = require("../config/redisConfig");

const alertQueue = new Bull("alert-processing", {
  redis: redisConfig,
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 20,
    attempts: 1,
  },
});

alertQueue.on("error", (err) => {
  if (String(err.message).includes("MISCONF")) return;
  console.error("Alert queue error:", err.message);
});

module.exports = alertQueue;
