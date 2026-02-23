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
const config = require("../config/config");

const alertQueue = new Bull("alert-processing", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
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
