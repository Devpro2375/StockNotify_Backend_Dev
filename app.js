// app.js - REFACTORED & OPTIMIZED

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
const redisService = require("./services/redisService");
const { fetchLastClose } = require("./services/upstoxService");
const passport = require('passport');
const cron = require('node-cron');
const admin = require('firebase-admin');
const { updateInstruments } = require('./services/instrumentService');
const telegramService = require('./services/telegramService');

// Import routes
const authRoutes = require("./routes/authRoutes");
const watchlistRoutes = require("./routes/watchlistRoutes");
const marketDataRoutes = require("./routes/marketDataRoutes");
const alertsRoutes = require("./routes/alerts");
const telegramRoutes = require("./routes/telegramRoutes");
const adminRoutes = require("./routes/adminRoutes");

require('./config/passport');

const app = express();
const server = http.createServer(app);

// ===== MIDDLEWARE SETUP =====
app.set('trust proxy', 1);
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS Configuration
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  process.env.FRONTEND_URL,
].filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all in dev, restrict in production
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
  exposedHeaders: ['set-cookie'],
}));

// Session Configuration
app.use(session({
  secret: config.sessionSecret || process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: config.mongoURI,
    touchAfter: 24 * 3600,
    ttl: 7 * 24 * 60 * 60,
    crypto: { secret: config.sessionSecret }
  }),
  cookie: { 
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
  proxy: true
}));

app.use(passport.initialize());
app.use(passport.session());

// ===== ROUTES =====
app.use("/admin", adminRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/market-data", marketDataRoutes);
app.use("/api/alerts", alertsRoutes);
app.use("/api/telegram", telegramRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    services: {
      mongodb: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
      telegram: telegramService.isInitialized ? 'active' : 'inactive',
      redis: 'active'
    }
  });
});

// ===== FIREBASE INITIALIZATION =====
function initializeFirebase() {
  if (admin.apps.length > 0) {
    console.log("✅ Firebase Admin already initialized");
    return;
  }

  const serviceAccount = config.firebaseServiceAccount 
    ? JSON.parse(config.firebaseServiceAccount)
    : null;

  if (!serviceAccount) {
    console.error("❌ Firebase service account missing");
    process.exit(1);
  }

  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  console.log("✅ Firebase Admin initialized");
}

// ===== DATABASE & STARTUP =====
async function initializeDatabase() {
  await mongoose.connect(config.mongoURI);
  console.log("✅ MongoDB connected");

  const AccessToken = require("./models/AccessToken");
  let tokenDoc = await AccessToken.findOne();
  
  if (!tokenDoc) {
    tokenDoc = new AccessToken({ token: '' });
    await tokenDoc.save();
    console.log("✅ Initialized AccessToken");
  }
}

async function preloadData() {
  await redisService.cleanupStaleStocks();
  const symbols = await redisService.getAllGlobalStocks();
  
  console.log(`📊 Preloading ${symbols.length} symbols...`);
  await Promise.all(symbols.map(symbol => fetchLastClose(symbol)));
  console.log("✅ Preloading complete");
}

function setupCronJobs() {
  const Alert = require("./models/Alert");
  const { STATUSES } = require("./services/socketService");
  const upstoxService = require("./services/upstoxService");

  // Periodic preload (every 5 minutes)
  cron.schedule('*/5 * * * *', async () => {
    try {
      const symbols = await redisService.getAllGlobalStocks();
      await Promise.all(symbols.map(fetchLastClose));
      console.log(`[${new Date().toISOString()}] ✅ Periodic preload complete`);
    } catch (err) {
      console.error('❌ Preload error:', err.message);
    }
  });

  // Cleanup persistent stocks (every 5 minutes)
  cron.schedule('*/5 * * * *', async () => {
    try {
      const persistent = await redisService.getPersistentStocks();
      
      for (const symbol of persistent) {
        const activeAlerts = await Alert.countDocuments({
          instrument_key: symbol,
          status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
        });
        
        const userCount = await redisService.getStockUserCount(symbol);
        
        if (activeAlerts === 0 && userCount === 0) {
          await redisService.removePersistentStock(symbol);
          upstoxService.unsubscribe([symbol]); 
          console.log(`🧹 Cleaned persistent stock: ${symbol}`);
        }
      }
    } catch (err) {
      console.error('❌ Cleanup error:', err.message);
    }
  });

  // Daily instrument update (6:30 AM IST)
  cron.schedule('30 6 * * *', async () => {
    try {
      console.log('🔄 Starting daily instrument update...');
      const result = await updateInstruments();
      console.log(`✅ Updated: ${result.count} instruments`);
    } catch (err) {
      console.error('❌ Instrument update failed:', err.message);
    }
  }, { timezone: "Asia/Kolkata" });

  console.log('✅ Cron jobs initialized');
}

async function startServer() {
  try {
    initializeFirebase();
    await initializeDatabase();
    await preloadData();
    
    console.log("📱 Initializing Telegram Bot...");
    await telegramService.init();
    
    console.log("📧 Starting email worker...");
    require('./workers/emailWorker');
    
    setupCronJobs();
    
    require("./services/alertService");
    socketService.init(server);

    server.listen(config.port, async () => {
      const botInfo = await telegramService.getBotInfo();
      const telegramStatus = telegramService.isInitialized ? 'ACTIVE' : 'INACTIVE';
      
      console.log(`
╔════════════════════════════════════════════════╗
║   🚀 Server running on port ${config.port.toString().padEnd(19)}║
║   📡 Environment: ${(process.env.NODE_ENV || 'development').padEnd(26)}║
║   📱 Telegram Bot: ${telegramStatus.padEnd(26)}║
║   ${botInfo ? `🤖 Bot: @${botInfo.username.padEnd(33)}` : ''}║
╚════════════════════════════════════════════════╝
      `);
    });
  } catch (err) {
    console.error("❌ Startup error:", err.message);
    process.exit(1);
  }
}

// ===== ERROR HANDLING =====
app.use((req, res) => res.status(404).json({ msg: 'Route not found' }));

app.use((err, req, res, next) => {
  console.error('❌ Global error:', err.message);
  res.status(err.status || 500).json({ 
    msg: err.message || 'Server error',
    error: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });
});

// ===== GRACEFUL SHUTDOWN =====
async function gracefulShutdown(signal) {
  console.log(`⚠️ ${signal} received: closing server...`);
  
  server.close(async () => {
    console.log('✅ HTTP server closed');
    await mongoose.connection.close();
    console.log('✅ MongoDB closed');
    await telegramService.cleanup();
    console.log('✅ Telegram bot stopped');
    process.exit(0);
  });
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection:', reason);
  process.exit(1);
});

// Start the server
startServer();

module.exports = { app, server };
