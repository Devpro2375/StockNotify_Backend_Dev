// queues/telegramQueue.js
// REFACTORED: Removed duplicate process.on('SIGTERM') handler (app.js handles shutdown),
// removed verbose waiting/error logging, cleaned up redundant error handler.

const Bull = require("bull");
const config = require("../config/config");
const telegramService = require("../services/telegramService");
const logger = require("../utils/logger");

const telegramQueue = new Bull("telegram-notifications", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 2000 },
    removeOnComplete: 10,
    removeOnFail: 20,
  },
});

telegramQueue.on("error", (err) => {
  if (String(err.message).includes("MISCONF")) return;
  logger.error("Telegram queue error", { error: err.message });
});

// Process telegram notifications
telegramQueue.process(async (job) => {
  const { chatId, alertDetails } = job.data;

  if (!chatId || chatId === "null" || chatId === "undefined") {
    throw new Error("Invalid chat ID");
  }

  const success = await telegramService.sendAlert(chatId, alertDetails);
  if (!success) {
    throw new Error("Failed to send Telegram notification");
  }

  return { chatId, status: "sent" };
});

telegramQueue.on("completed", (job, result) => {
  logger.info(`Telegram job ${job.id} completed for chat ${result.chatId}`);
});

telegramQueue.on("failed", (job, err) => {
  logger.error(`Telegram job ${job.id} failed`, { error: err.message, chatId: job.data.chatId });
});

// Cleanup every 5 minutes
const cleanupInterval = setInterval(async () => {
  try {
    await telegramQueue.clean(60 * 60 * 1000, "completed");
    await telegramQueue.clean(6 * 60 * 60 * 1000, "failed");
  } catch (error) {
    if (!String(error.message).includes("MISCONF")) {
      logger.error("Telegram queue cleanup error", { error: error.message });
    }
  }
}, 5 * 60 * 1000);
cleanupInterval.unref();

module.exports = telegramQueue;
