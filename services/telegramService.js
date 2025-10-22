const TelegramBot = require("node-telegram-bot-api");
const config = require("../config/config");
const User = require("../models/User");

class TelegramService {
  constructor() {
    this.bot = null;
    this.isInitialized = false;
    this.pollingActive = false;
  }

  async init() {
    if (!config.telegramBotToken) {
      console.warn("⚠️ Telegram bot token not configured");
      return;
    }

    try {
      // Initialize bot without polling first
      this.bot = new TelegramBot(config.telegramBotToken, {
        polling: false,
      });

      const botInfo = await this.bot.getMe();
      console.log(`📱 Connected to Telegram bot: @${botInfo.username}`);

      // FORCE delete any existing webhook/polling
      await this.bot.deleteWebHook();
      console.log("✅ Cleared existing webhook");

      const isProduction = process.env.NODE_ENV === "production";
      const hasValidWebhook =
        config.telegramWebhookUrl &&
        config.telegramWebhookUrl.startsWith("https://");

      if (isProduction && hasValidWebhook) {
        // Production: Use ONLY webhook
        try {
          await this.bot.setWebHook(config.telegramWebhookUrl, {
            max_connections: 100,
            drop_pending_updates: false,
          });
          console.log("✅ Telegram webhook set:", config.telegramWebhookUrl);

          // Verify webhook is set
          const webhookInfo = await this.bot.getWebHookInfo();
          console.log("📋 Webhook info:", webhookInfo);
        } catch (error) {
          console.error("❌ Webhook setup failed:", error.message);
          throw error; // Don't fallback to polling in production
        }
      } else {
        // Development: Use ONLY polling
        await this.startPolling();
      }

      this.setupCommands();
      this.isInitialized = true;
      console.log("✅ Telegram bot initialized successfully");
    } catch (error) {
      console.error("❌ Telegram bot initialization failed:", error.message);
      this.isInitialized = false;
    }
  }

  async startPolling() {
    try {
      // Ensure no webhook exists
      await this.bot.deleteWebHook();
      await this.sleep(1000);

      // Start polling with proper configuration
      await this.bot.startPolling({
        restart: false,
        polling: {
          interval: 1000,
          autoStart: true,
          params: {
            timeout: 30,
          },
        },
      });

      this.pollingActive = true;
      console.log("✅ Telegram polling started");

      // Handle polling errors
      this.bot.on("polling_error", (error) => {
        console.error("❌ Telegram polling error:", error.message);

        // Don't auto-restart on 409 - it means another instance is running
        if (error.code === "ETELEGRAM" && error.response?.statusCode === 409) {
          console.error("⚠️ CONFLICT: Another bot instance is running!");
          console.error("⚠️ Stop all other instances before restarting.");
          process.exit(1); // Exit to prevent conflicts
        }
      });
    } catch (error) {
      console.error("❌ Failed to start polling:", error.message);
      this.pollingActive = false;
      throw error;
    }
  }

setupCommands() {
  if (!this.bot) return;

  // Start command - WITH TAP-TO-COPY
  this.bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const username = msg.from.username || msg.from.first_name || 'User';

    try {
      const existingUser = await User.findOne({ telegramChatId: chatId.toString() });
      
      if (existingUser) {
        const message = `✅ Already linked!

👤 ${existingUser.name}
📧 ${existingUser.email}

Your Chat ID: <code>${chatId}</code>
(Tap above to copy)`;

        await this.bot.sendMessage(chatId, message, {
          parse_mode: 'HTML'
        });
        return;
      }
    } catch (error) {
      console.error('Error checking user:', error);
    }

    // New user message with HTML formatting
    const message = `👋 Hi ${username}!

Get instant stock alerts on Telegram.

<b>Your Chat ID:</b>
<code>${chatId}</code>
(Tap above to copy)

<b>Next Steps:</b>
1️⃣ Copy your Chat ID above
2️⃣ Open the web app
3️⃣ Go to Settings → Telegram
4️⃣ Paste your Chat ID and click Link

✅ Done! You'll receive alerts here.`;

    const keyboard = {
      inline_keyboard: [
        [{ text: '❓ Help', callback_data: 'help' }]
      ]
    };

    await this.bot.sendMessage(chatId, message, {
      parse_mode: 'HTML',
      reply_markup: keyboard
    });
  });

  // Handle callback queries
  this.bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const data = callbackQuery.data;

    try {
      if (data === 'help') {
        const guide = `*🔗 How to Link:*

1️⃣ Send /start to get your Chat ID
2️⃣ Copy the Chat ID number
3️⃣ Open app → Settings → Telegram  
4️⃣ Paste Chat ID and click Link

✅ Done! Alerts will arrive here.

*Commands:*
/start - Get Chat ID
/status - Check link status
/help - Show this message`;
        
        await this.bot.sendMessage(chatId, guide, {
          parse_mode: 'Markdown'
        });
      }
      else if (data === 'status') {
        const user = await User.findOne({ telegramChatId: chatId.toString() });
        
        if (!user) {
          await this.bot.sendMessage(chatId, '❌ Not linked. Use /start to get your Chat ID.');
          await this.bot.answerCallbackQuery(callbackQuery.id);
          return;
        }

        const Alert = require('../models/Alert');
        const alertCount = await Alert.countDocuments({ user: user._id });

        const statusMsg = `*✅ Linked Successfully*

👤 ${user.name}
🔔 ${alertCount} active alerts
📅 Since ${new Date(user.telegramLinkedAt).toLocaleDateString()}`;

        await this.bot.sendMessage(chatId, statusMsg, {
          parse_mode: 'Markdown'
        });
      }
      
      await this.bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
      console.error('❌ Callback error:', error);
      await this.bot.answerCallbackQuery(callbackQuery.id, {
        text: '❌ Error. Try /start again.',
        show_alert: true
      });
    }
  });

  // Status command
  this.bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
      const user = await User.findOne({ telegramChatId: chatId.toString() });
      
      if (!user) {
        await this.sendMessage(chatId, '❌ Not linked. Use /start to get your Chat ID.');
        return;
      }

      const Alert = require('../models/Alert');
      const alertCount = await Alert.countDocuments({ user: user._id });

      const message = `*✅ Account Active*

👤 ${user.name}
🔔 ${alertCount} alerts
📅 ${new Date(user.telegramLinkedAt).toLocaleDateString()}`;

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown'
      });
    } catch (error) {
      console.error('Status error:', error);
      await this.sendMessage(chatId, '❌ Error. Try /start again.');
    }
  });

  // Help command
  this.bot.onText(/\/help/, async (msg) => {
    const message = `*📚 Commands*

/start - Get your Chat ID
/status - Check link status
/help - Show this message

*Setup Steps:*
1. Send /start
2. Copy Chat ID
3. Link in web app
4. Receive alerts here`;

    await this.bot.sendMessage(msg.chat.id, message, {
      parse_mode: 'Markdown'
    });
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

      await this.sendMessage(chatId, '✅ Unlinked successfully. Use /start to reconnect.');
    } catch (error) {
      console.error('Unlink error:', error);
      await this.sendMessage(chatId, '❌ Error. Try again later.');
    }
  });
}


  /**
   * Send alert notification (PLAIN TEXT - NO MARKDOWN)
   */
  async sendAlert(chatId, alertDetails) {
    if (!this.isInitialized || !this.bot) {
      console.warn("⚠️ Telegram bot not initialized");
      return false;
    }

    // Validate chat ID
    if (
      !chatId ||
      chatId === "null" ||
      chatId === "undefined" ||
      chatId.trim() === ""
    ) {
      console.error("❌ Invalid chat ID:", chatId);
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
      level,
    } = alertDetails;

    const statusConfig = {
      slHit: { emoji: "🛑", title: "STOP LOSS HIT" },
      targetHit: { emoji: "🎯", title: "TARGET REACHED" },
      enter: { emoji: "🚀", title: "ENTRY SIGNAL" },
      running: { emoji: "📈", title: "TRADE RUNNING" },
      nearEntry: { emoji: "⚠️", title: "NEAR ENTRY" },
    };

    const statusInfo = statusConfig[status] || statusConfig.enter;

    // Calculate P&L
    let pnlPercent = 0;
    if (status === "targetHit" || status === "slHit") {
      if (trend === "bullish") {
        pnlPercent = ((current_price - entry_price) / entry_price) * 100;
      } else {
        pnlPercent = ((entry_price - current_price) / entry_price) * 100;
      }
    }

    const pnlText =
      status === "targetHit" || status === "slHit"
        ? `\n💰 P&L: ${pnlPercent > 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`
        : "";

    // Plain text message (NO MARKDOWN)
    const message = `${statusInfo.emoji} ${statusInfo.title}

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

⏰ ${new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`;

    try {
      await this.sendMessageWithRetry(chatId, message, {
        disable_web_page_preview: true,
      });
      return true;
    } catch (error) {
      console.error(
        `❌ Telegram send failed for chat ${chatId}:`,
        error.message
      );
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
        const errorMessage =
          error.message || error.response?.body?.description || "";

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
        if (errorMessage.includes("chat not found")) {
          console.error(
            `❌ Chat not found: ${chatId}. User needs to /start bot first.`
          );
          await User.findOneAndUpdate(
            { telegramChatId: chatId.toString() },
            { telegramEnabled: false, telegramChatId: null }
          );
          return false;
        }

        // Handle Markdown parsing errors - remove parse_mode and retry
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

        console.error(
          `❌ Telegram error (attempt ${attempt}/${retries}):`,
          errorMessage
        );

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
      console.error("❌ Webhook processing error:", error.message);
    }
  }

  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get bot info
   */
  async getBotInfo() {
    if (!this.bot) return null;
    try {
      return await this.bot.getMe();
    } catch (error) {
      console.error("Error getting bot info:", error);
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
        console.log("✅ Telegram polling stopped");
      } catch (error) {
        console.error("❌ Error stopping polling:", error);
      }
    }
  }
}

const telegramService = new TelegramService();
module.exports = telegramService;
