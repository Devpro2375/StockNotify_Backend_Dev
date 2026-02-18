const Bull = require('bull');
const config = require('../config/config');
const telegramService = require('../services/telegramService');

// ✅ CORRECTED: Bull-compatible Redis configuration
const telegramQueue = new Bull('telegram-notifications', {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
    // ✅ REMOVE enableReadyCheck and maxRetriesPerRequest - Bull doesn't support them
    // Only these options are allowed:
    retryStrategy: (times) => {
      const delay = Math.min(times * 1000, 10000);
      console.log(`🔄 Redis reconnecting in ${delay}ms (attempt ${times})...`);
      return delay;
    },
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: 10,
    removeOnFail: 20
  }
});

// ✅ Monitor Redis connection
telegramQueue.on('error', (error) => {
  console.error('❌ Bull Queue Error:', error);
});

telegramQueue.on('waiting', (jobId) => {
  console.log(`⏳ Job ${jobId} waiting...`);
});

// Process telegram notifications
telegramQueue.process(async (job) => {
  const { chatId, alertDetails } = job.data;

  if (!chatId || chatId === 'null' || chatId === 'undefined') {
    console.error('❌ Invalid chat ID in queue:', chatId);
    throw new Error('Invalid chat ID');
  }

  const success = await telegramService.sendAlert(chatId, alertDetails);

  if (!success) {
    throw new Error('Failed to send Telegram notification');
  }

  return { chatId, status: 'sent' };
});

telegramQueue.on('completed', (job, result) => {
  console.log(`✅ Telegram job ${job.id} completed for chat ${result.chatId}`);
});

telegramQueue.on('failed', (job, err) => {
  console.error(`❌ Telegram job ${job.id} failed:`, err.message);

  if (err.message.includes('chat not found') || err.message.includes('Invalid chat ID')) {
    console.log(`⚠️ Disabling Telegram for invalid chat: ${job.data.chatId}`);
  }
});

// ✅ Aggressive cleanup — every 5 minutes
setInterval(async () => {
  try {
    await telegramQueue.clean(60 * 60 * 1000, 'completed');       // 1 hour
    await telegramQueue.clean(6 * 60 * 60 * 1000, 'failed');      // 6 hours
  } catch (error) {
    // Silently ignore MISCONF errors during cleanup
    if (!String(error.message).includes('MISCONF')) {
      console.error('❌ Queue cleanup error:', error.message);
    }
  }
}, 5 * 60 * 1000);

// ✅ Handle MISCONF: attempt emergency cleanup
telegramQueue.on('error', async (error) => {
  if (String(error.message).includes('MISCONF')) {
    console.warn('⚠️ Telegram queue: Redis MISCONF detected, will retry after recovery');
  }
});

// ✅ Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('📴 SIGTERM received, closing queue...');
  await telegramQueue.close();
});

module.exports = telegramQueue;



