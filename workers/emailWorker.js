const emailQueue = require("../queues/emailQueue");
const emailService = require("../utils/email");
const logger = require("../utils/logger");

emailQueue.process(async (job) => {
  const { userEmail, alertDetails } = job.data;
  logger.info(`Processing email job ${job.id} for ${userEmail} - ${alertDetails.trading_symbol}`);

  try {
    return await emailService.sendAlertEmailNow(userEmail, alertDetails);
  } catch (error) {
    logger.error(`Email job ${job.id} failed`, { error: error.message });
    throw error;
  }
});

logger.info("Email worker started");

module.exports = emailQueue;
