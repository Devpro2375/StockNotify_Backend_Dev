// app.js
require("dotenv").config();

const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const cookieParser = require("cookie-parser");
const session = require("express-session");
const MongoStore = require("connect-mongo");
const cron = require("node-cron");
const passport = require("passport");

const config = require("./config/config");
const socketService = require("./services/socketService");
const authRoutes = require("./routes/authRoutes");
const watchlistRoutes = require("./routes/watchlistRoutes");
const marketDataRoutes = require("./routes/marketDataRoutes");
const tokenRoutes = require("./routes/tokenRoutes");
const alertsRoutes = require("./routes/alerts");
const telegramRoutes = require("./routes/telegramRoutes");
const adminRoutes = require("./routes/adminRoutes");
const historyRoutes = require("./routes/historyRoutes");

const { fetchLastClose, getWsStatus } = require("./services/upstoxService");
const redisService = require("./services/redisService");
const telegramService = require("./services/telegramService");
const AccessToken = require("./models/AccessToken");
const { updateInstruments } = require("./services/instrumentService");
const { STATUSES } = require("./services/constants");

// Ensure a single Firebase Admin instance across the app
const admin = require("./services/firebase");

// Initialize Passport strategies
require("./config/passport");

// --------------------------------------------------
// App / HTTP server bootstrap
// --------------------------------------------------
const app = express();
const server = http.createServer(app);

// Trust proxy for platforms like Railway/Render/Heroku
app.set("trust proxy", 1);

// Security/stability improvements
app.disable("x-powered-by");

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.FRONTEND_URL,
  config.frontendBaseUrl,
  "https://your-frontend-domain.vercel.app",
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    const isAllowed = allowedOrigins.includes(origin);
    if (isAllowed || process.env.NODE_ENV !== "production") {
      return callback(null, true);
    }
    return callback(new Error("CORS: Origin not allowed"), false);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  exposedHeaders: ["set-cookie"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// Sessions
app.use(
  session({
    name: "sid",
    secret:
      config.sessionSecret ||
      process.env.SESSION_SECRET ||
      "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: config.mongoURI,
      touchAfter: 24 * 3600,
      ttl: 7 * 24 * 60 * 60,
      crypto: {
        secret:
          config.sessionSecret ||
          process.env.SESSION_SECRET ||
          "change-this-secret-in-production",
      },
    }),
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    },
    proxy: true,
  })
);

// Passport
app.use(passport.initialize());
app.use(passport.session());

// --------------------------------------------------
// Routes
// --------------------------------------------------
app.use("/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/market-data", marketDataRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/telegram", telegramRoutes);
app.use("/api/token", tokenRoutes);
app.use("/api/history", historyRoutes);

// Health check
app.get("/health", async (req, res) => {
  const mongoReady =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  let redis = "unknown";
  try {
    redis =
      (await redisService.ping()) === "PONG" ? "connected" : "disconnected";
  } catch {
    redis = "disconnected";
  }
  const ws = getWsStatus();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    services: {
      mongodb: mongoReady,
      telegram: telegramService.isInitialized ? "active" : "inactive",
      redis,
      upstoxWs: ws.status,
      push: admin?.apps?.length ? "active" : "inactive",
    },
  });
});

// --------------------------------------------------
// Database connection & startup
// --------------------------------------------------
mongoose
  .connect(config.mongoURI)
  .then(async () => {
    console.log("✅ MongoDB connected");

    // Ensure AccessToken doc exists
    let tokenDoc = await AccessToken.findOne();
    if (!tokenDoc) {
      tokenDoc = new AccessToken({ token: "" });
      await tokenDoc.save();
      console.log("✅ Initialized empty AccessToken in DB.");
    }

    // Redis cleanup & warmup — parallelized
    await redisService.cleanupStaleStocks();
    const symbols = await redisService.getAllGlobalStocks();
    if (symbols.length) {
      console.log("📊 Preloading close prices for:", symbols.length, "symbols");
      // Parallel preload with concurrency limit to avoid API throttling
      const BATCH_SIZE = 10;
      for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
        const batch = symbols.slice(i, i + BATCH_SIZE);
        await Promise.allSettled(batch.map((sym) => fetchLastClose(sym)));
      }
    }
    console.log("✅ Preloading complete.");

    // ==== CRON JOBS ====

    // 1) Upstox token auto-refresh — daily 6:30 AM IST
    const UpstoxTokenRefresh = require("./services/upstoxTokenRefresh");
    cron.schedule(
      "30 6 * * *",
      async () => {
        console.log(
          `[${new Date().toISOString()}] 🔄 Upstox token refresh started`
        );
        try {
          const refresher = new UpstoxTokenRefresh();
          const result = await refresher.refreshToken();
          if (result.success) {
            console.log(
              `[${new Date().toISOString()}] ✅ Token refresh successful - expires at ${result.expiresAt
              }`
            );
          } else {
            console.error(
              `[${new Date().toISOString()}] ❌ Token refresh failed: ${result.error
              }`
            );
          }
        } catch (err) {
          console.error(
            `[${new Date().toISOString()}] ❌ Token refresh error:`,
            err.message
          );
        }
      },
      { timezone: "Asia/Kolkata" }
    );
    console.log("✅ Upstox token refresh cron scheduled at 6:30 AM IST daily");

    // 2) Periodic preload of close prices (every 5 minutes)
    cron.schedule("*/5 * * * *", async () => {
      try {
        const syms = await redisService.getAllGlobalStocks();
        const BATCH_SIZE = 10;
        for (let i = 0; i < syms.length; i += BATCH_SIZE) {
          const batch = syms.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(batch.map((sym) => fetchLastClose(sym)));
        }
      } catch (err) {
        console.error("❌ Error in periodic preload:", err);
      }
    });

    // 3) Cleanup persistent stocks (every 5 minutes)
    cron.schedule("*/5 * * * *", async () => {
      try {
        const Alert = require("./models/Alert");
        const persistent = await redisService.getPersistentStocks();
        for (const symbol of persistent) {
          const activeAlerts = await Alert.countDocuments({
            instrument_key: symbol,
            status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
          });
          if (
            activeAlerts === 0 &&
            (await redisService.getStockUserCount(symbol)) === 0
          ) {
            await redisService.removePersistentStock(symbol);
            require("./services/upstoxService").unsubscribe([symbol]);
            console.log(`🧹 Cleaned persistent stock: ${symbol}`);
          }
        }
      } catch (err) {
        console.error("❌ Error in persistent stock cleanup:", err);
      }
    });

    // 4) Daily instrument update at 6:30 AM IST
    cron.schedule(
      "30 6 * * *",
      async () => {
        try {
          console.log("🔄 Starting scheduled daily instrument update...");
          const result = await updateInstruments();
          console.log(
            `[${new Date().toISOString()}] ✅ Instrument update complete: ${result.count
            } instruments (deleted ${result.deleted} old)`
          );
        } catch (err) {
          console.error(
            `[${new Date().toISOString()}] ❌ Scheduled instrument update failed:`,
            err.message
          );
        }
      },
      { timezone: "Asia/Kolkata" }
    );
    console.log("✅ Instrument update cron scheduled at 6:30 AM IST daily");

    // Initialize Telegram bot
    console.log("📱 Initializing Telegram Bot...");
    await telegramService.init();

    // Start email worker (queue-based)
    console.log("📧 Starting email worker...");
    require("./workers/emailWorker");

    // Register alert queue processor + start in-memory cache
    const alertService = require("./services/alertService");
    alertService.startCacheRefresh();

    // Initialize Socket Service (Upstox WS connection established inside)
    socketService.init(server);

    // Start background alert subscription manager
    // Ensures all stocks with active alerts are subscribed to Upstox WS
    const alertSubscriptionManager = require("./services/alertSubscriptionManager");
    await alertSubscriptionManager.start();

    // Start server
    server.listen(config.port, async () => {
      const botInfo = await telegramService.getBotInfo();
      const telegramStatus = telegramService.isInitialized
        ? "ACTIVE"
        : "INACTIVE";
      const botUsername = botInfo ? `@${botInfo.username}` : "N/A";
      const ws = getWsStatus();

      console.log(`
╔══════════════════════════════════════════════════════════╗
║   🚀 Server running on port ${String(config.port).padEnd(29)}║
║   📡 Environment: ${(process.env.NODE_ENV || "development").padEnd(30)}║
║   🌐 Frontend URL: ${(
          config.frontendBaseUrl ||
          process.env.FRONTEND_URL ||
          "N/A"
        ).padEnd(27)}║
║   📧 Email Worker: ACTIVE                                 ║
║   🔔 Firebase Push: ${admin?.apps?.length ? "ACTIVE".padEnd(37) : "INACTIVE".padEnd(37)
        }║
║   📱 Telegram Bot: ${telegramStatus.padEnd(37)}║
║   🤖 Bot Username: ${String(botUsername).padEnd(37)}║
║   🔌 Upstox WS:   ${ws.status.padEnd(37)}║
║   ⏰ Cron Jobs: 4 ACTIVE                                   ║
╚══════════════════════════════════════════════════════════╝
      `);

      if (botInfo) {
        console.log(`📱 Telegram Bot Ready: @${botInfo.username}`);
        console.log(
          `🔗 Users can start chat: https://t.me/${botInfo.username}`
        );
      }
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// --------------------------------------------------
// Error handling
// --------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ msg: "Route not found" });
});

app.use((err, req, res, next) => {
  console.error("❌ Global error handler:", err);
  res.status(err.status || 500).json({
    msg: err.message || "Server error",
    error: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// --------------------------------------------------
// Graceful shutdown — close all queues + connections
// --------------------------------------------------
async function shutdown(signal) {
  try {
    console.log(`⚠️ ${signal} signal received: closing HTTP server`);
    server.close(async () => {
      console.log("✅ HTTP server closed");

      // Close all Bull queues
      try {
        const alertQueue = require("./queues/alertQueue");
        const emailQueue = require("./queues/emailQueue");
        const telegramQueue = require("./queues/telegramQueue");
        await Promise.allSettled([
          alertQueue.close(),
          emailQueue.close(),
          telegramQueue.close(),
        ]);
        console.log("✅ All Bull queues closed");
      } catch (e) {
        console.error("❌ Queue close error", e);
      }

      // Stop alert subscription manager + cache
      try {
        const alertSubscriptionManager = require("./services/alertSubscriptionManager");
        alertSubscriptionManager.stop();
        const alertService = require("./services/alertService");
        alertService.stopCacheRefresh();
        console.log("✅ Alert subscription manager + cache stopped");
      } catch (e) {
        console.error("❌ Alert subscription manager stop error", e);
      }

      try {
        await mongoose.connection.close();
        console.log("✅ MongoDB connection closed");
      } catch (e) {
        console.error("❌ MongoDB close error", e);
      }
      try {
        await redisService.quit();
        console.log("✅ Redis connection closed");
      } catch (e) {
        console.error("❌ Redis close error", e);
      }

      // Stop Telegram bot (polling)
      try {
        await telegramService.cleanup();
        console.log("✅ Telegram bot stopped");
      } catch (e) {
        console.error("❌ Telegram stop error", e);
      }

      process.exit(0);
    });
  } catch (e) {
    console.error("❌ Error during shutdown:", e);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.once("SIGUSR2", () => shutdown("SIGUSR2")); // Verify graceful reload with nodemon

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

module.exports = { app, server };
