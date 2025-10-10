const Bull = require('bull');
const config = require('../config/config');
const telegramService = require('../services/telegramService');

const telegramQueue = new Bull('telegram-notifications', {
  redis: {
    host: config.redisHost,
    port: config.redisPort,
    password: config.redisPassword,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 2000
    },
    removeOnComplete: true,
    removeOnFail: false
  }
});

// Process telegram notifications
telegramQueue.process(async (job) => {
  const { chatId, alertDetails } = job.data;

  if (!chatId) {
    throw new Error('No chat ID provided');
  }

  // Validate chat ID
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

// Event handlers
telegramQueue.on('completed', (job, result) => {
  console.log(`✅ Telegram job ${job.id} completed for chat ${result.chatId}`);
});

telegramQueue.on('failed', (job, err) => {
  console.error(`❌ Telegram job ${job.id} failed:`, err.message);
  
  // If chat not found, log it
  if (err.message.includes('chat not found') || err.message.includes('Invalid chat ID')) {
    console.log(`⚠️ Disabling Telegram for invalid chat: ${job.data.chatId}`);
  }
});

// Cleanup old jobs every 10 minutes
setInterval(async () => {
  await telegramQueue.clean(24 * 3600 * 1000, 'completed'); // 24 hours
  await telegramQueue.clean(7 * 24 * 3600 * 1000, 'failed'); // 7 days
  console.log('✅ Telegram queue cleaned');
}, 10 * 60 * 1000);

module.exports = telegramQueue;
