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

// Security/stability improvements without new hard deps
app.disable("x-powered-by");

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS — safe and flexible
const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.FRONTEND_BASE_URL,
  config.frontendBaseUrl,
  "https://www.stocknotify.in",
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser clients (curl, mobile, server-to-server)
    if (!origin) return callback(null, true);

    // Strict in production; permissive in development
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
      ttl: 7 * 24 * 60 * 60, // seconds
      crypto: {
        secret:
          config.sessionSecret ||
          process.env.SESSION_SECRET ||
          "change-this-secret-in-production",
      },
    }),
    cookie: {
      secure: process.env.NODE_ENV === "production", // HTTPS only in prod
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000, // ms
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

    // Redis cleanup & warmup
    await redisService.cleanupStaleStocks();
    const symbols = await redisService.getAllGlobalStocks();
    if (symbols.length) {
      console.log("📊 Preloading close prices for:", symbols.length, "symbols");
    }
    for (const symbol of symbols) {
      try {
        await fetchLastClose(symbol);
      } catch (e) {
        console.warn(
          `⚠️ Preload last close failed for ${symbol}: ${e.message}`
        );
      }
    }
    console.log("✅ Preloading complete.");

    // Initialize Scheduler (Cron Jobs)
    const schedulerService = require("./services/schedulerService");
    schedulerService.init();

    // Initialize Telegram bot
    console.log("📱 Initializing Telegram Bot...");
    await telegramService.init();

    // Start email worker (queue-based)
    console.log("📧 Starting email worker...");
    require("./workers/emailWorker");

    // Start alert queue processor (registers processor & exports constants)
    const alertService = require("./services/alertService");
    await alertService.syncAlertsToRedis();

    // Initialize Socket Service (Upstox WS connection established inside)
    socketService.init(server);

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
║   🔔 Firebase Push: ${
        admin?.apps?.length ? "ACTIVE".padEnd(37) : "INACTIVE".padEnd(37)
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
// Graceful shutdown
// --------------------------------------------------
async function shutdown(signal) {
  try {
    console.log(`⚠️ ${signal} signal received: closing HTTP server`);
    server.close(async () => {
      console.log("✅ HTTP server closed");
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
      process.exit(0);
    });
  } catch (e) {
    console.error("❌ Error during shutdown:", e);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("❌ Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

module.exports = { app, server };
