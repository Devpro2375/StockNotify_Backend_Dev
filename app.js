require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const cookieParser = require('cookie-parser');
const session = require('express-session');
const MongoStore = require('connect-mongo');
const config = require("./config/config");
const socketService = require("./services/socketService");
const authRoutes = require("./routes/authRoutes");
const watchlistRoutes = require("./routes/watchlistRoutes");
const marketDataRoutes = require("./routes/marketDataRoutes");
const redisService = require("./services/redisService");
const { fetchLastClose } = require("./services/upstoxService");
const alertsRoutes = require("./routes/alerts");
const passport = require('passport');
require('./config/passport');
const cron = require('node-cron');
const Alert = require("./models/Alert");
const upstoxService = require("./services/upstoxService");
const { STATUSES } = require("./services/socketService");
const admin = require('firebase-admin');
const adminRoutes = require("./routes/adminRoutes");
const AccessToken = require("./models/AccessToken");
const { updateInstruments } = require('./services/instrumentService');

const app = express();
const server = http.createServer(app);

// ===== MIDDLEWARE SETUP =====

// 0. Trust proxy - CRITICAL for Railway/Render/Heroku
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

// 1. Cookie Parser - MUST come before routes
app.use(cookieParser());

// 2. Body Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 3. CORS Configuration
const corsOptions = {
  origin: config.frontendBaseUrl || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  exposedHeaders: ['set-cookie']
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

// 4. Session Configuration with MongoDB Store
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: config.mongoURI,
    touchAfter: 24 * 3600,
    ttl: 24 * 60 * 60
  }),
  cookie: { 
    // FIXED: Proper cookie settings for local development
    secure: process.env.NODE_ENV === 'production' && process.env.USE_HTTPS === 'true',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// 5. Passport Configuration
app.use(passport.initialize());
app.use(passport.session());

// ===== ROUTES =====
app.use("/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/market-data", marketDataRoutes);
app.use("/api/alerts", alertsRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== FIREBASE ADMIN INITIALIZATION =====
let serviceAccount = null;

if (config.firebaseServiceAccount) {
  try {
    serviceAccount = JSON.parse(config.firebaseServiceAccount);
  } catch (err) {
    console.error("Failed to parse Firebase service account JSON from env variable", err);
    process.exit(1);
  }
} else {
  console.error("Firebase service account not provided. Set FIREBASE_SERVICE_ACCOUNT in environment.");
  process.exit(1);
}

if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
  console.log("✅ Firebase Admin initialized successfully.");
} else {
  console.log("✅ Firebase Admin already initialized.");
}

// ===== DATABASE CONNECTION & SERVER STARTUP =====
mongoose
  .connect(config.mongoURI)
  .then(async () => {
    console.log("✅ MongoDB connected");

    // Initialize AccessToken document if missing
    let tokenDoc = await AccessToken.findOne();
    if (!tokenDoc) {
      tokenDoc = new AccessToken({ token: '' });
      await tokenDoc.save();
      console.log("✅ Initialized empty AccessToken in DB.");
    }

    // Redis cleanup and preloading
    await redisService.cleanupStaleStocks();
    const symbols = await redisService.getAllGlobalStocks();
    console.log("📊 Preloading close prices for:", symbols);
    for (let symbol of symbols) {
      await fetchLastClose(symbol);
    }
    console.log("✅ Preloading complete.");

    // ===== START EMAIL WORKER =====
    console.log("📧 Starting email worker...");
    require('./workers/emailWorker');

    // ===== CRON JOBS =====

    // 1. Periodic preload of close prices (every 5 minutes)
    cron.schedule('*/5 * * * *', async () => {
      try {
        const symbols = await redisService.getAllGlobalStocks();
        for (let symbol of symbols) {
          await fetchLastClose(symbol);
        }
        console.log(`[${new Date().toISOString()}] ✅ Periodic preload complete.`);
      } catch (err) {
        console.error('❌ Error in periodic preload:', err);
      }
    });

    // 2. Cleanup persistent stocks (every 5 minutes)
    cron.schedule('*/5 * * * *', async () => {
      try {
        const persistent = await redisService.getPersistentStocks();
        for (const symbol of persistent) {
          const activeAlerts = await Alert.countDocuments({
            instrument_key: symbol,
            status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
          });
          if (activeAlerts === 0 && (await redisService.getStockUserCount(symbol)) === 0) {
            await redisService.removePersistentStock(symbol);
            upstoxService.unsubscribe([symbol]); 
            console.log(`🧹 Cleaned persistent stock: ${symbol}`);
          }
        }
        console.log(`[${new Date().toISOString()}] ✅ Cleaned up persistent stocks`);
      } catch (err) {
        console.error('❌ Error in persistent stock cleanup:', err);
      }
    });

    // 3. Daily instrument update at 6:30 AM IST
    cron.schedule('30 6 * * *', async () => {
      try {
        console.log('🔄 Starting scheduled daily instrument update...');
        const result = await updateInstruments();
        console.log(`[${new Date().toISOString()}] ✅ Instrument update complete: ${result.count} instruments (deleted ${result.deleted} old)`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] ❌ Scheduled instrument update failed:`, err.message);
      }
    }, {
      timezone: "Asia/Kolkata"
    });

    console.log('✅ Instrument update cron scheduled at 6:30 AM IST daily');

    // Start alert queue processor
    require("./services/alertService");

    // Initialize Socket Service
    socketService.init(server);

    // Start server
    server.listen(config.port, () => {
      console.log(`
╔════════════════════════════════════════════════╗
║   🚀 Server running on port ${config.port}            ║
║   📡 Environment: ${process.env.NODE_ENV || 'development'}                  ║
║   🌐 Frontend URL: ${config.frontendBaseUrl}  ║
║   📧 Email Worker: ACTIVE                      ║
║   ⏰ Cron Jobs: 3 ACTIVE                       ║
╚════════════════════════════════════════════════╝
      `);
    });
  })
  .catch((err) => {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  });

// ===== ERROR HANDLING =====

// 404 handler
app.use((req, res) => {
  res.status(404).json({ msg: 'Route not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('❌ Global error handler:', err.stack);
  res.status(err.status || 500).json({ 
    msg: err.message || 'Server error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ===== GRACEFUL SHUTDOWN =====
process.on('SIGTERM', async () => {
  console.log('⚠️ SIGTERM signal received: closing HTTP server');
  server.close(async () => {
    console.log('✅ HTTP server closed');
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('⚠️ SIGINT signal received: closing HTTP server');
  server.close(async () => {
    console.log('✅ HTTP server closed');
    await mongoose.connection.close();
    console.log('✅ MongoDB connection closed');
    process.exit(0);
  });
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

module.exports = { app, server };
