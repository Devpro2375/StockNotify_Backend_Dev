const Bull = require("bull");
const config = require("../config/config");

// Dedicated Email Queue with optimized settings
const emailQueue = new Bull("email-notifications", {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  // Rate limiting: 5 emails per second (Gmail limit)
  limiter: {
    max: 5,
    duration: 1000,
  },
  // Job options
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 10,
    removeOnFail: 20,
  },
});

// Monitor queue events
emailQueue.on('completed', (job, result) => {
  console.log(`✅ Email job ${job.id} completed: ${result.messageId}`);
});

emailQueue.on('failed', (job, err) => {
  console.error(`❌ Email job ${job.id} failed after ${job.attemptsMade} attempts:`, err.message);
});

emailQueue.on('stalled', (job) => {
  console.warn(`⚠️ Email job ${job.id} stalled, will retry`);
});

// ✅ Aggressive cleanup — every 5 minutes
setInterval(async () => {
  try {
    await emailQueue.clean(60 * 60 * 1000, 'completed');       // 1 hour
    await emailQueue.clean(6 * 60 * 60 * 1000, 'failed');      // 6 hours
  } catch (error) {
    if (!String(error.message).includes('MISCONF')) {
      console.error('❌ Email queue cleanup error:', error.message);
    }
  }
}, 5 * 60 * 1000);

module.exports = emailQueue;
