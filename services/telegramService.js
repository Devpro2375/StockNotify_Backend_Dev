// services/telegramService.js

const TelegramBot = require('node-telegram-bot-api');
const config = require('../config/config');
const User = require('../models/User');

class TelegramService {
  constructor() {
    this.bot = null;
    this.isInitialized = false;
    this.pollingActive = false;
  }

  /**
   * Initialize Telegram Bot with webhook or polling
   */
  async init() {
    if (!config.telegramBotToken) {
      console.warn('⚠️ Telegram bot token not configured');
      return;
    }

    try {
      // Initialize bot
      this.bot = new TelegramBot(config.telegramBotToken, { 
        polling: false 
      });

      // Test bot connectivity
      const botInfo = await this.bot.getMe();
      console.log(`📱 Connected to Telegram bot: @${botInfo.username}`);

      // Determine mode
      const isProduction = process.env.NODE_ENV === 'production';
      const hasValidWebhook = config.telegramWebhookUrl && 
                             config.telegramWebhookUrl.startsWith('https://');

      if (isProduction && hasValidWebhook) {
        // Production: Webhook mode
        try {
          await this.bot.deleteWebHook();
          await this.bot.setWebHook(config.telegramWebhookUrl);
          console.log('✅ Telegram webhook set:', config.telegramWebhookUrl);
        } catch (error) {
          console.error('❌ Webhook setup failed:', error.message);
          console.log('⚠️ Falling back to polling...');
          await this.startPolling();
        }
      } else {
        // Development: Polling mode
        if (config.telegramWebhookUrl) {
          console.warn('⚠️ Webhook requires HTTPS. Using polling for development.');
        }
        await this.startPolling();
      }

      this.setupCommands();
      this.isInitialized = true;
      console.log('✅ Telegram bot initialized successfully');
    } catch (error) {
      console.error('❌ Telegram bot initialization failed:', error.message);
      this.isInitialized = false;
    }
  }

  /**
   * Start polling mode
   */
  async startPolling() {
    try {
      await this.bot.deleteWebHook();
      
      await this.bot.startPolling({ 
        restart: true,
        polling: {
          interval: 300,
          autoStart: true,
          params: {
            timeout: 10
          }
        }
      });

      this.pollingActive = true;
      console.log('✅ Telegram polling started');

      this.bot.on('polling_error', (error) => {
        console.error('❌ Telegram polling error:', error.message);
        if (error.code === 'ETELEGRAM' && error.response?.statusCode === 409) {
          console.log('⚠️ Conflict detected. Restarting polling...');
          this.restartPolling();
        }
      });
    } catch (error) {
      console.error('❌ Failed to start polling:', error.message);
      this.pollingActive = false;
    }
  }

  /**
   * Restart polling
   */
  async restartPolling() {
    try {
      await this.bot.stopPolling();
      await this.sleep(2000);
      await this.startPolling();
    } catch (error) {
      console.error('❌ Failed to restart polling:', error.message);
    }
  }

  /**
   * Setup bot commands
   */
  setupCommands() {
    if (!this.bot) return;

    // Start command
    this.bot.onText(/\/start/, async (msg) => {
      const chatId = msg.chat.id;
      const username = msg.from.username || msg.from.first_name || 'User';

      const message = `
🤖 Welcome to Stock Alerts Bot!

Hi ${username}! 👋

To receive real-time stock alerts:

1️⃣ Copy your Chat ID: ${chatId}
2️⃣ Go to the app settings
3️⃣ Link your Telegram account
4️⃣ Start receiving instant alerts! 🚀

Use /help to see all commands.
      `.trim();

      await this.sendMessage(chatId, message);
    });

    // Help command
    this.bot.onText(/\/help/, async (msg) => {
      const chatId = msg.chat.id;
      const message = `
📚 Available Commands

/start - Get your Chat ID
/status - Check your alert status
/link - Get linking instructions
/unlink - Unlink your account
/help - Show this message

Need support? Contact your admin.
      `.trim();

      await this.sendMessage(chatId, message);
    });

    // Status command
    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      
      try {
        const user = await User.findOne({ telegramChatId: chatId.toString() });
        
        if (!user) {
          await this.sendMessage(chatId, '❌ Account not linked. Use /start to link your account.');
          return;
        }

        const Alert = require('../models/Alert');
        const alertCount = await Alert.countDocuments({ user: user._id });

        const message = `
✅ Account Status

👤 User: ${user.name}
📧 Email: ${user.email}
🔔 Active Alerts: ${alertCount}
📅 Linked: ${new Date(user.telegramLinkedAt).toLocaleDateString()}

Status: Active 🟢
        `.trim();

        await this.sendMessage(chatId, message);
      } catch (error) {
        console.error('Status command error:', error);
        await this.sendMessage(chatId, '❌ Error fetching status. Please try again.');
      }
    });

    // Link command
    this.bot.onText(/\/link/, async (msg) => {
      const chatId = msg.chat.id;
      const message = `
🔗 Link Your Account

1. Copy your Chat ID: ${chatId}
2. Open the app settings
3. Navigate to Notifications → Telegram
4. Paste your Chat ID
5. Click "Link Account"

Done! You'll start receiving alerts immediately. 🎉
      `.trim();

      await this.sendMessage(chatId, message);
    });

    // Unlink command
    this.bot.onText(/\/unlink/, async (msg) => {
      const chatId = msg.chat.id;
      
      try {
        const user = await User.findOne({ telegramChatId: chatId.toString() });
        
        if (!user) {
          await this.sendMessage(chatId, '❌ No linked account found.');
          return;
        }

        user.telegramChatId = null;
        user.telegramUsername = null;
        user.telegramEnabled = false;
        await user.save();

        await this.sendMessage(chatId, '✅ Account unlinked successfully. Use /start to link again.');
      } catch (error) {
        console.error('Unlink command error:', error);
        await this.sendMessage(chatId, '❌ Error unlinking account. Please try again.');
      }
    });
  }

  /**
   * Send alert notification (PLAIN TEXT - NO MARKDOWN)
   */
  async sendAlert(chatId, alertDetails) {
    if (!this.isInitialized || !this.bot) {
      console.warn('⚠️ Telegram bot not initialized');
      return false;
    }

    // Validate chat ID
    if (!chatId || chatId === 'null' || chatId === 'undefined') {
      console.error('❌ Invalid chat ID:', chatId);
      return false;
    }

    const { 
      trading_symbol, 
      status, 
      current_price, 
      entry_price, 
      stop_loss, 
      target_price, 
      trend,
      trade_type,
      level
    } = alertDetails;

    const statusConfig = {
      slHit: { emoji: '🛑', title: 'STOP LOSS HIT' },
      targetHit: { emoji: '🎯', title: 'TARGET REACHED' },
      enter: { emoji: '🚀', title: 'ENTRY SIGNAL' },
      running: { emoji: '📈', title: 'TRADE RUNNING' },
      nearEntry: { emoji: '⚠️', title: 'NEAR ENTRY' }
    };

    const statusInfo = statusConfig[status] || statusConfig.enter;

    // Calculate P&L
    let pnlPercent = 0;
    if (status === 'targetHit' || status === 'slHit') {
      if (trend === 'bullish') {
        pnlPercent = ((current_price - entry_price) / entry_price) * 100;
      } else {
        pnlPercent = ((entry_price - current_price) / entry_price) * 100;
      }
    }

    const pnlText = (status === 'targetHit' || status === 'slHit') 
      ? `\n💰 P&L: ${pnlPercent > 0 ? '+' : ''}${pnlPercent.toFixed(2)}%` 
      : '';

    // Plain text message (NO MARKDOWN)
    const message = `
${statusInfo.emoji} ${statusInfo.title}

📊 ${trading_symbol}
━━━━━━━━━━━━━━━
💰 Current: ₹${current_price.toFixed(2)}
📍 Entry: ₹${entry_price.toFixed(2)}
🛡️ Stop Loss: ₹${stop_loss.toFixed(2)}
🎯 Target: ₹${target_price.toFixed(2)}
━━━━━━━━━━━━━━━
📊 Trend: ${trend.toUpperCase()}
⏱️ Type: ${trade_type.toUpperCase()}
⭐ Level: ${level}/7${pnlText}

⏰ ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
    `.trim();

    try {
      await this.sendMessageWithRetry(chatId, message, { 
        disable_web_page_preview: true 
      });
      return true;
    } catch (error) {
      console.error(`❌ Telegram send failed for chat ${chatId}:`, error.message);
      return false;
    }
  }

  /**
   * Send message with retry logic
   */
  async sendMessageWithRetry(chatId, text, options = {}, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.bot.sendMessage(chatId, text, options);
        console.log(`✅ Telegram sent to ${chatId}`);
        return true;
      } catch (error) {
        const errorMessage = error.message || error.response?.body?.description || '';

        // Handle rate limit (429)
        if (error.response && error.response.statusCode === 429) {
          const retryAfter = error.response.body?.parameters?.retry_after || 30;
          console.warn(`⚠️ Rate limited. Retrying after ${retryAfter}s`);
          
          if (attempt < retries) {
            await this.sleep(retryAfter * 1000);
            continue;
          }
        }

        // Handle blocked user (403)
        if (error.response && error.response.statusCode === 403) {
          console.warn(`⚠️ User blocked bot: ${chatId}`);
          await User.findOneAndUpdate(
            { telegramChatId: chatId.toString() },
            { telegramEnabled: false }
          );
          return false;
        }

        // Handle chat not found (400)
        if (errorMessage.includes('chat not found')) {
          console.error(`❌ Chat not found: ${chatId}. User needs to start bot first.`);
          await User.findOneAndUpdate(
            { telegramChatId: chatId.toString() },
            { telegramEnabled: false }
          );
          return false;
        }

        // Handle Markdown parsing errors
        if (errorMessage.includes("can't parse entities")) {
          console.error(`❌ Markdown parsing error. Removing formatting...`);
          if (options.parse_mode) {
            delete options.parse_mode;
            if (attempt < retries) {
              await this.sleep(1000);
              continue;
            }
          }
        }

        console.error(`❌ Telegram error (attempt ${attempt}/${retries}):`, errorMessage);
        
        if (attempt < retries) {
          await this.sleep(2000 * attempt);
        }
      }
    }
    return false;
  }

  /**
   * Send simple message
   */
  async sendMessage(chatId, text, options = {}) {
    return this.sendMessageWithRetry(chatId, text, options);
  }

  /**
   * Process webhook update
   */
  async processUpdate(update) {
    if (!this.bot) return;
    
    try {
      await this.bot.processUpdate(update);
    } catch (error) {
      console.error('❌ Webhook processing error:', error.message);
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get bot info
   */
  async getBotInfo() {
    if (!this.bot) return null;
    try {
      return await this.bot.getMe();
    } catch (error) {
      console.error('Error getting bot info:', error);
      return null;
    }
  }

  /**
   * Cleanup
   */
  async cleanup() {
    if (this.pollingActive && this.bot) {
      try {
        await this.bot.stopPolling();
        console.log('✅ Telegram polling stopped');
      } catch (error) {
        console.error('❌ Error stopping polling:', error);
      }
    }
  }
}

const telegramService = new TelegramService();
module.exports = telegramService;
