const emailQueue = require('../queues/emailQueue');
const emailService = require('../utils/email');

// Process email jobs from the queue
emailQueue.process(async (job) => {
  const { userEmail, alertDetails } = job.data;
  
  console.log(`📬 Processing email job ${job.id} for ${userEmail} - ${alertDetails.trading_symbol}`);
  
  try {
    const result = await emailService.sendAlertEmailNow(userEmail, alertDetails);
    return result; // Return success result
  } catch (error) {
    console.error(`❌ Email job ${job.id} failed:`, error.message);
    throw error; // Bull will handle retries automatically
  }
});


console.log('✅ Email worker started and listening for jobs');

module.exports = emailQueue;
