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
    attempts: 3, // Retry failed emails up to 3 times
    backoff: {
      type: 'exponential',
      delay: 2000, // Start with 2 second delay, then exponential backoff
    },
    removeOnComplete: 100, // Keep last 100 completed jobs for monitoring
    removeOnFail: 500, // Keep last 500 failed jobs for debugging
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

// Clean up old jobs every 6 hours
setInterval(async () => {
  await emailQueue.clean(24 * 60 * 60 * 1000, 'completed'); // Remove completed jobs older than 24 hours
  await emailQueue.clean(7 * 24 * 60 * 60 * 1000, 'failed'); // Remove failed jobs older than 7 days
  console.log('✅ Email queue cleaned');
}, 6 * 60 * 60 * 1000);

module.exports = emailQueue;
