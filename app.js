require('dotenv').config();
const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const session = require('express-session');
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


const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false }
}));
app.use(passport.initialize());
app.use(passport.session());

app.use("/admin", adminRoutes);

app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/market-data", marketDataRoutes);
app.use("/api/alerts", alertsRoutes);

// Firebase Admin initialization using environment variable config
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
  console.log("Firebase Admin initialized successfully.");
} else {
  console.log("Firebase Admin already initialized.");
}

mongoose
  .connect(config.mongoURI)
  .then(async () => {
    console.log("MongoDB connected");

    // Initialize AccessToken document if missing
    let tokenDoc = await AccessToken.findOne();
    if (!tokenDoc) {
      tokenDoc = new AccessToken({ token: '' });
      await tokenDoc.save();
      console.log("Initialized empty AccessToken in DB.");
    }

    await redisService.cleanupStaleStocks();
    const symbols = await redisService.getAllGlobalStocks();
    console.log("Preloading close prices for:", symbols);
    for (let symbol of symbols) {
      await fetchLastClose(symbol);
    }
    console.log("Preloading complete.");

    cron.schedule('*/5 * * * *', async () => {
      const symbols = await redisService.getAllGlobalStocks();
      for (let symbol of symbols) {
        await fetchLastClose(symbol);
      }
      console.log('Periodic preload complete.');
    });

    cron.schedule('*/5 * * * *', async () => {
      const persistent = await redisService.getPersistentStocks();
      for (const symbol of persistent) {
        const activeAlerts = await Alert.countDocuments({
          instrument_key: symbol,
          status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
        });
        if (activeAlerts === 0 && (await redisService.getStockUserCount(symbol)) === 0) {
          await redisService.removePersistentStock(symbol);
          upstoxService.unsubscribe([symbol]); 
          console.log(`Cleaned persistent stock: ${symbol}`);
        }
      }
      console.log('Cleaned up persistent stocks');
    });

    // Start alert queue processor
    require("./services/alertService");

    socketService.init(server);
    server.listen(config.port, () =>
      console.log(`Server running on port ${config.port}`)
    );
  })
  
  .catch((err) => console.error(err));
