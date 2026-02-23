// app.js
// ──────────────────────────────────────────────────────────────
// REFACTORED:
//  1. Replaced console.log with structured Winston logger
//  2. Metrics auto-start (60s summary interval)
//  3. Removed alertQueue import (alerts processed inline now)
//  4. Consolidated redundant persistent stock cleanup (handled by alertSubscriptionManager)
//  5. Health check includes metrics snapshot
//  6. Graceful shutdown properly stops metrics + flushes Redis tick buffer
// ──────────────────────────────────────────────────────────────
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
const logger = require("./utils/logger");
const metrics = require("./utils/metrics");

const admin = require("./services/firebase");
require("./config/passport");

// --------------------------------------------------
// App / HTTP server bootstrap
// --------------------------------------------------
const app = express();
const server = http.createServer(app);

app.set("trust proxy", 1);
app.disable("x-powered-by");

// --------------------------------------------------
// Middleware
// --------------------------------------------------
app.use(cookieParser());
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

const allowedOrigins = [
  "http://localhost:3000",
  "http://localhost:3001",
  process.env.FRONTEND_URL,
  config.frontendBaseUrl,
].filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || process.env.NODE_ENV !== "production") {
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

app.use(
  session({
    name: "sid",
    secret: config.sessionSecret || process.env.SESSION_SECRET || "change-this-secret-in-production",
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: config.mongoURI,
      touchAfter: 24 * 3600,
      ttl: 7 * 24 * 60 * 60,
      crypto: {
        secret: config.sessionSecret || process.env.SESSION_SECRET || "change-this-secret-in-production",
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
  const mongoReady = mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  let redis = "unknown";
  try {
    redis = (await redisService.ping()) === "PONG" ? "connected" : "disconnected";
  } catch {
    redis = "disconnected";
  }
  const ws = getWsStatus();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
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
    logger.info("MongoDB connected");

    // Ensure AccessToken doc exists
    let tokenDoc = await AccessToken.findOne();
    if (!tokenDoc) {
      tokenDoc = new AccessToken({ token: "" });
      await tokenDoc.save();
      logger.info("Initialized empty AccessToken in DB");
    }

    // Redis cleanup & warmup (critical for 500MB limit)
    try {
      await redisService.cleanupStaleStocks();
      await redisService.deepCleanupRedisMemory();
      const symbols = await redisService.getAllGlobalStocks();
      if (symbols.length) {
        logger.info(`Preloading close prices for ${symbols.length} symbols`);
        const BATCH_SIZE = 10;
        for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
          const batch = symbols.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(batch.map((sym) => fetchLastClose(sym)));
        }
      }
      logger.info("Preloading complete");
    } catch (redisErr) {
      logger.warn("Redis warmup failed (server will continue)", { error: redisErr.message });
    }

    // ==== CRON JOBS ====
    // Store task references for graceful shutdown
    const cronTasks = [];

    // 1) Upstox token auto-refresh — daily 6:30 AM IST
    const UpstoxTokenRefresh = require("./services/upstoxTokenRefresh");
    cronTasks.push(cron.schedule(
      "30 6 * * *",
      async () => {
        logger.info("Cron: Upstox token refresh fired");
        const attempt = async (num) => {
          try {
            const refresher = new UpstoxTokenRefresh();
            const result = await refresher.refreshToken();
            if (result.success) {
              logger.info(`Token refresh successful - expires at ${result.expiresAt}`);
              return true;
            }
            logger.error(`Token refresh failed: ${result.error}`);
            return false;
          } catch (err) {
            logger.error("Token refresh error", { error: err.message, attempt: num });
            return false;
          }
        };

        if (!(await attempt(1))) {
          logger.info("Retrying token refresh in 30s...");
          await new Promise((r) => setTimeout(r, 30_000));
          await attempt(2);
        }
      },
      { timezone: "Asia/Kolkata" }
    ));

    // 2) Periodic preload of close prices (every 5 minutes)
    cronTasks.push(cron.schedule("*/5 * * * *", async () => {
      try {
        const syms = await redisService.getAllGlobalStocks();
        const BATCH_SIZE = 10;
        for (let i = 0; i < syms.length; i += BATCH_SIZE) {
          const batch = syms.slice(i, i + BATCH_SIZE);
          await Promise.allSettled(batch.map((sym) => fetchLastClose(sym)));
        }
      } catch (err) {
        logger.error("Error in periodic preload", { error: err.message });
      }
    }));

    // 3) Daily instrument update at 6:35 AM IST (5 min after token refresh to avoid resource contention)
    cronTasks.push(cron.schedule(
      "35 6 * * *",
      async () => {
        try {
          logger.info("Starting scheduled daily instrument update...");
          const result = await updateInstruments();
          logger.info(`Instrument update complete: ${result.count} instruments (deleted ${result.deleted} old)`);
        } catch (err) {
          logger.error("Scheduled instrument update failed", { error: err.message });
        }
      },
      { timezone: "Asia/Kolkata" }
    ));

    // 4) Deep Redis memory cleanup (every 30 minutes) — critical for 500MB limit
    cronTasks.push(cron.schedule("*/30 * * * *", async () => {
      try {
        await redisService.deepCleanupRedisMemory();
      } catch (err) {
        logger.error("Error in deep Redis cleanup", { error: err.message });
      }
    }));

    // 5) Drain old alert queue data from Redis (one-time on startup)
    //    Alert processing moved to inline — clean out stale Bull queue keys
    try {
      const alertQueue = require("./queues/alertQueue");
      await alertQueue.empty();
      await alertQueue.clean(0, "completed");
      await alertQueue.clean(0, "failed");
      await alertQueue.clean(0, "delayed");
      await alertQueue.clean(0, "wait");
      await alertQueue.clean(0, "active");
      await alertQueue.close();
      logger.info("Old alert queue drained and closed");
    } catch (err) {
      logger.warn("Alert queue drain error (non-critical)", { error: err.message });
    }

    logger.info("Cron jobs scheduled: token refresh, close price preload, instrument update, Redis cleanup");

    // Initialize services
    logger.info("Initializing Telegram Bot...");
    await telegramService.init();

    logger.info("Starting email worker...");
    require("./workers/emailWorker");

    // Start alert cache (no more Bull queue processor registration)
    const alertService = require("./services/alertService");
    alertService.startCacheRefresh();

    // Initialize Socket.IO + Upstox WS
    socketService.init(server);

    // Start alert subscription manager
    const alertSubscriptionManager = require("./services/alertSubscriptionManager");
    await alertSubscriptionManager.start();

    // Start server
    server.listen(config.port, async () => {
      const botInfo = await telegramService.getBotInfo();
      const ws = getWsStatus();

      logger.info("Server started", {
        port: config.port,
        env: process.env.NODE_ENV || "development",
        telegram: telegramService.isInitialized ? "active" : "inactive",
        bot: botInfo ? `@${botInfo.username}` : "N/A",
        upstoxWs: ws.status,
        firebase: admin?.apps?.length ? "active" : "inactive",
      });
    });
  })
  .catch((err) => {
    logger.error("MongoDB connection error", { error: err.message });
    process.exit(1);
  });

// --------------------------------------------------
// Error handling
// --------------------------------------------------
app.use((req, res) => {
  res.status(404).json({ msg: "Route not found" });
});

app.use((err, req, res, _next) => {
  logger.error("Global error handler", { error: err.message, stack: err.stack });
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
    logger.info(`${signal} received: closing server`);
    server.close(async () => {
      logger.info("HTTP server closed");

      // Stop all cron jobs first to prevent them firing after connections close
      try {
        const allTasks = cron.getTasks();
        for (const [, task] of allTasks) {
          task.stop();
        }
        logger.info("Cron jobs stopped");
      } catch (e) {
        logger.error("Cron stop error", { error: e.message });
      }

      // Stop metrics collection
      metrics.stop();

      // Close Bull queues (email + telegram only; alert queue no longer used)
      try {
        const emailQueue = require("./queues/emailQueue");
        const telegramQueue = require("./queues/telegramQueue");
        await Promise.allSettled([emailQueue.close(), telegramQueue.close()]);
        logger.info("Bull queues closed");
      } catch (e) {
        logger.error("Queue close error", { error: e.message });
      }

      // Stop alert services
      try {
        const alertSubscriptionManager = require("./services/alertSubscriptionManager");
        alertSubscriptionManager.stop();
        const alertService = require("./services/alertService");
        alertService.stopCacheRefresh();
        logger.info("Alert services stopped");
      } catch (e) {
        logger.error("Alert service stop error", { error: e.message });
      }

      try {
        await mongoose.connection.close();
        logger.info("MongoDB connection closed");
      } catch (e) {
        logger.error("MongoDB close error", { error: e.message });
      }

      // Flush tick buffer then close Redis
      try {
        await redisService.flushAndQuit();
        logger.info("Redis connection closed (tick buffer flushed)");
      } catch (e) {
        logger.error("Redis close error", { error: e.message });
      }

      try {
        await telegramService.cleanup();
        logger.info("Telegram bot stopped");
      } catch (e) {
        logger.error("Telegram stop error", { error: e.message });
      }

      process.exit(0);
    });
  } catch (e) {
    logger.error("Error during shutdown", { error: e.message });
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.once("SIGUSR2", () => shutdown("SIGUSR2"));

process.on("uncaughtException", (err) => {
  logger.error("Uncaught Exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  const msg = String(reason?.message || reason || "");
  if (msg.includes("Connection is closed") || msg.includes("ECONNRESET")) {
    logger.warn("Suppressed Redis rejection during shutdown", { reason: msg });
    return;
  }
  logger.error("Unhandled Rejection", { reason: msg });
});

module.exports = { app, server };
