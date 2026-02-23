// queues/emailQueue.js
// REFACTORED: Replaced console.log with logger, added .unref() to cleanup interval.

const Bull = require("bull");
const config = require("../config/config");
const logger = require("../utils/logger");

const emailQueue = new Bull("email-notifications", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  limiter: { max: 5, duration: 1000 },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 10,
    removeOnFail: 20,
  },
});

emailQueue.on("completed", (job, result) => {
  logger.info(`Email job ${job.id} completed`, { messageId: result?.messageId });
});

emailQueue.on("failed", (job, err) => {
  logger.error(`Email job ${job.id} failed after ${job.attemptsMade} attempts`, { error: err.message });
});

emailQueue.on("stalled", (job) => {
  logger.warn(`Email job ${job.id} stalled, will retry`);
});

// Cleanup every 5 minutes
const cleanupInterval = setInterval(async () => {
  try {
    await emailQueue.clean(60 * 60 * 1000, "completed");
    await emailQueue.clean(6 * 60 * 60 * 1000, "failed");
  } catch (error) {
    if (!String(error.message).includes("MISCONF")) {
      logger.error("Email queue cleanup error", { error: error.message });
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();

module.exports = emailQueue;
