// services/telegramService.js

const TelegramBot = require("node-telegram-bot-api");
const config = require("../config/config");
const User = require("../models/User");
const logger = require("../utils/logger");

class TelegramService {
  constructor() {
    this.bot = null;
    this.isInitialized = false;
    this.pollingActive = false;
    this.commandsSetup = false;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 5;
    this.healthCheckInterval = null;
  }

  async init() {
    if (!config.telegramBotToken) {
      console.warn("⚠️ Telegram bot token not configured");
      return;
    }

    try {
      // Create bot instance with polling disabled initially
      this.bot = new TelegramBot(config.telegramBotToken, { polling: false });

      const botInfo = await this.bot.getMe();
      console.log(`📱 Connected to Telegram bot: @${botInfo.username}`);

      // Clear any existing webhook
      await this.bot.deleteWebHook();
      console.log("✅ Cleared existing webhook");

      const isProduction = process.env.NODE_ENV === "production";
      const hasValidWebhook =
        config.telegramWebhookUrl &&
        config.telegramWebhookUrl.startsWith("https://");

      if (isProduction && hasValidWebhook) {
        try {
          await this.setupWebhook();
        } catch (webhookErr) {
          console.warn(
            "⚠️ Webhook setup failed, falling back to polling:",
            webhookErr.message,
          );
          await this.startPolling();
        }
      } else {
        await this.startPolling();
      }

      if (!this.commandsSetup) {
        this.setupCommands();
        this.commandsSetup = true;
      }

      this.setupErrorHandlers();
      this.startHealthCheck();

      this.isInitialized = true;
      console.log("✅ Telegram bot initialized successfully");
    } catch (error) {
      console.error("❌ Telegram bot initialization failed:", error.message);
      this.isInitialized = false;
      await this.scheduleReconnect();
    }
  }

  async setupWebhook() {
    try {
      await this.bot.setWebHook(config.telegramWebhookUrl, {
        max_connections: 100,
        drop_pending_updates: false,
      });
      console.log("✅ Telegram webhook set:", config.telegramWebhookUrl);

      const webhookInfo = await this.bot.getWebHookInfo();
      console.log("📋 Webhook info:", webhookInfo);
    } catch (error) {
      console.error("❌ Webhook setup failed:", error.message);
      throw error;
    }
  }

  async startPolling() {
    try {
      // Stop any existing polling first to avoid 409 conflict
      try {
        await this.bot.stopPolling();
      } catch {}
      await this.bot.deleteWebHook();
      await this.sleep(1000);

      await this.bot.startPolling({
        restart: true,
        polling: { interval: 1000, autoStart: true, params: { timeout: 30 } },
      });

      this.pollingActive = true;
      this.reconnectAttempts = 0;
      console.log("✅ Telegram polling started");
    } catch (error) {
      console.error("❌ Failed to start polling:", error.message);
      this.pollingActive = false;
      throw error;
    }
  }

  setupErrorHandlers() {
    if (!this.bot) return;

    this.bot.on("polling_error", async (error) => {
      // Suppress 409 spam — only log once then stop polling to let the other instance run
      if (error.code === "ETELEGRAM" && error.response?.statusCode === 409) {
        if (!this._conflict409Logged) {
          console.error(
            "⚠️ Telegram 409: Another bot instance running. Stopping polling.",
          );
          this._conflict409Logged = true;
        }
        try {
          await this.bot.stopPolling();
        } catch {}
        this.pollingActive = false;
        return;
      }

      // Suppress EFATAL spam during restart
      if (error.code === "EFATAL") return;

      console.error("❌ Telegram polling error:", error.code, error.message);

      if (
        error.code === "ETIMEDOUT" ||
        error.code === "ENETUNREACH" ||
        error.code === "ECONNRESET" ||
        (error.response && error.response.statusCode === 502)
      ) {
        console.warn("⚠️ Network error, polling will auto-retry");
        return;
      }

      if (error.code === "EFATAL") {
        console.error("❌ FATAL: Bot token issue");
        this.pollingActive = false;
        await this.scheduleReconnect();
      }
    });

    this.bot.on("error", (error) =>
      console.error("❌ Telegram bot error:", error),
    );
    this.bot.on("webhook_error", (error) =>
      console.error("❌ Telegram webhook error:", error),
    );
  }

  async scheduleReconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error(
        "❌ Max reconnect attempts reached. Manual intervention needed.",
      );
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(5000 * this.reconnectAttempts, 30000);

    console.log(
      `🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${
        this.maxReconnectAttempts
      })`,
    );

    await this.sleep(delay);

    try {
      await this.cleanup();
      await this.init();
    } catch (error) {
      console.error("❌ Reconnect failed:", error.message);
      await this.scheduleReconnect();
    }
  }

  startHealthCheck() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);

    this.healthCheckInterval = setInterval(
      async () => {
        try {
          if (!this.bot) {
            console.warn("⚠️ Bot instance lost, reinitializing...");
            await this.init();
            return;
          }
          await this.bot.getMe();
          console.log("✅ Telegram health check passed");
        } catch (error) {
          console.error("❌ Health check failed:", error.message);

          if (this.pollingActive) {
            console.log("🔄 Restarting polling...");
            try {
              await this.bot.stopPolling();
              await this.sleep(2000);
              await this.startPolling();
            } catch (restartError) {
              console.error("❌ Restart failed:", restartError.message);
              await this.scheduleReconnect();
            }
          }
        }
      },
      5 * 60 * 1000,
    );
  }

  setupCommands() {
    if (!this.bot) return;

    this.bot.onText(/\/start/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const username = msg.from.username || msg.from.first_name || "User";

        const existingUser = await User.findOne({
          telegramChatId: String(chatId),
        });

        if (existingUser) {
          const message = `✅ Already linked!

👤 ${existingUser.name}
📧 ${existingUser.email}

Your Chat ID: <code>${chatId}</code>
(Tap above to copy)`;
          await this.bot.sendMessage(chatId, message, { parse_mode: "HTML" });
          return;
        }

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
          inline_keyboard: [[{ text: "❓ Help", callback_data: "help" }]],
        };

        await this.bot.sendMessage(chatId, message, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });
      } catch (error) {
        console.error("❌ /start error:", error);
      }
    });

    this.bot.on("callback_query", async (callbackQuery) => {
      try {
        const chatId = callbackQuery.message.chat.id;
        const data = callbackQuery.data;

        if (data === "help") {
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
          await this.bot.sendMessage(chatId, guide, { parse_mode: "Markdown" });
        } else if (data === "status") {
          const user = await User.findOne({ telegramChatId: String(chatId) });

          if (!user) {
            await this.bot.sendMessage(
              chatId,
              "❌ Not linked. Use /start to get your Chat ID.",
            );
            await this.bot.answerCallbackQuery(callbackQuery.id);
            return;
          }

          const Alert = require("../models/Alert");
          const alertCount = await Alert.countDocuments({ user: user._id });

          const statusMsg = `*✅ Linked Successfully*

👤 ${user.name}
🔔 ${alertCount} active alerts
📅 Since ${new Date(user.telegramLinkedAt).toLocaleDateString()}`;

          await this.bot.sendMessage(chatId, statusMsg, {
            parse_mode: "Markdown",
          });
        }

        await this.bot.answerCallbackQuery(callbackQuery.id);
      } catch (error) {
        console.error("❌ Callback error:", error);
        try {
          await this.bot.answerCallbackQuery(callbackQuery.id, {
            text: "❌ Error. Try /start again.",
            show_alert: true,
          });
        } catch (answerError) {
          console.error("❌ Failed to answer callback:", answerError);
        }
      }
    });

    this.bot.onText(/\/status/, async (msg) => {
      const chatId = msg.chat.id;
      try {
        const user = await User.findOne({ telegramChatId: String(chatId) });
        if (!user) {
          await this.sendMessage(
            chatId,
            "❌ Not linked. Use /start to get your Chat ID.",
          );
          return;
        }

        const Alert = require("../models/Alert");
        const alertCount = await Alert.countDocuments({ user: user._id });

        const message = `*✅ Account Active*

👤 ${user.name}
🔔 ${alertCount} alerts
📅 ${new Date(user.telegramLinkedAt).toLocaleDateString()}`;

        await this.bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
      } catch (error) {
        console.error("❌ Status error:", error);
        await this.sendMessage(chatId, "❌ Error. Try /start again.");
      }
    });

    this.bot.onText(/\/help/, async (msg) => {
      try {
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
          parse_mode: "Markdown",
        });
      } catch (error) {
        console.error("❌ Help error:", error);
      }
    });

    this.bot.onText(/\/unlink/, async (msg) => {
      try {
        const chatId = msg.chat.id;
        const user = await User.findOne({ telegramChatId: String(chatId) });

        if (!user) {
          await this.sendMessage(chatId, "❌ No linked account found.");
          return;
        }

        user.telegramChatId = null;
        user.telegramUsername = null;
        user.telegramEnabled = false;
        await user.save();

        await this.sendMessage(
          chatId,
          "✅ Unlinked successfully. Use /start to reconnect.",
        );
      } catch (error) {
        console.error("❌ Unlink error:", error);
        await this.sendMessage(chatId, "❌ Error. Try again later.");
      }
    });
  }

  async sendAlert(chatId, alertDetails) {
    if (!this.isInitialized || !this.bot) {
      console.warn("⚠️ Telegram bot not initialized");
      return false;
    }

    if (
      !chatId ||
      chatId === "null" ||
      chatId === "undefined" ||
      String(chatId).trim() === ""
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
      position,
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

    let pnlPercent = 0;
    if (status === "targetHit" || status === "slHit") {
      if (position === "long") {
        pnlPercent = ((current_price - entry_price) / entry_price) * 100;
      } else {
        pnlPercent = ((entry_price - current_price) / entry_price) * 100;
      }
    }

    const pnlText =
      status === "targetHit" || status === "slHit"
        ? `\n💰 P&L: ${pnlPercent > 0 ? "+" : ""}${pnlPercent.toFixed(2)}%`
        : "";

    const message = `${statusInfo.emoji} ${statusInfo.title}

📊 ${trading_symbol}
━━━━━━━━━━━━━━━
💰 Current: ₹${current_price.toFixed(2)}
📍 Entry: ₹${entry_price.toFixed(2)}
🛡️ Stop Loss: ₹${stop_loss.toFixed(2)}
🎯 Target: ₹${target_price.toFixed(2)}
━━━━━━━━━━━━━━━
📊 Position: ${position.toUpperCase()}
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
        error.message,
      );
      return false;
    }
  }

  async sendMessageWithRetry(chatId, text, options = {}, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this.bot.sendMessage(chatId, text, options);
        console.log(`✅ Telegram sent to ${chatId}`);
        return true;
      } catch (error) {
        const desc = error.message || error.response?.body?.description || "";

        if (error.response?.statusCode === 429) {
          const retryAfter = error.response.body?.parameters?.retry_after || 30;
          console.warn(`⚠️ Rate limited. Retrying after ${retryAfter}s`);
          if (attempt < retries) {
            await this.sleep(retryAfter * 1000);
            continue;
          }
        }

        if (error.response?.statusCode === 403) {
          console.warn(`⚠️ User blocked bot: ${chatId}`);
          await User.findOneAndUpdate(
            { telegramChatId: String(chatId) },
            { telegramEnabled: false },
          );
          return false;
        }

        if (desc.includes("chat not found")) {
          console.error(
            `❌ Chat not found: ${chatId}. User needs to /start bot first.`,
          );
          await User.findOneAndUpdate(
            { telegramChatId: String(chatId) },
            { telegramEnabled: false, telegramChatId: null },
          );
          return false;
        }

        if (desc.includes("can't parse entities") && options.parse_mode) {
          console.error("❌ Markdown parsing error. Removing formatting...");
          delete options.parse_mode;
          if (attempt < retries) {
            await this.sleep(1000);
            continue;
          }
        }

        console.error(
          `❌ Telegram error (attempt ${attempt}/${retries}):`,
          desc,
        );
        if (attempt < retries) await this.sleep(2000 * attempt);
      }
    }
    return false;
  }

  async sendMessage(chatId, text, options = {}) {
    return this.sendMessageWithRetry(chatId, text, options);
  }

  async processUpdate(update) {
    if (!this.bot) return;
    try {
      await this.bot.processUpdate(update);
    } catch (error) {
      console.error("❌ Webhook processing error:", error.message);
    }
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async getBotInfo() {
    if (!this.bot) return null;
    try {
      return await this.bot.getMe();
    } catch (error) {
      console.error("Error getting bot info:", error);
      return null;
    }
  }

  async cleanup() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    if (this.bot) {
      // Remove all event listeners to prevent duplicate handlers on re-init
      this.bot.removeAllListeners("message");
      this.bot.removeAllListeners("callback_query");
      this.bot.removeAllListeners("polling_error");
      this.bot.removeAllListeners("error");
      this.bot.removeAllListeners("webhook_error");
      // Clear onText regex handlers
      this.bot._textRegexpCallbacks = [];
    }

    if (this.pollingActive && this.bot) {
      try {
        await this.bot.stopPolling();
        this.pollingActive = false;
        console.log("✅ Telegram polling stopped");
      } catch (error) {
        console.error("❌ Error stopping polling:", error);
      }
    }

    this.isInitialized = false;
    this.commandsSetup = false;
  }
}

const telegramService = new TelegramService();
module.exports = telegramService;
