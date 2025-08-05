const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const session = require('express-session'); // Add this
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

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

// Add session middleware BEFORE passport
app.use(session({
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set secure: true in production with HTTPS
}));

app.use(passport.initialize());
app.use(passport.session()); // Add this for Passport session support

app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/market-data", marketDataRoutes);
app.use("/api/alerts", alertsRoutes);

mongoose
  .connect(config.mongoURI)
  .then(async () => {
    console.log("MongoDB connected");

    await redisService.cleanupStaleStocks();

    const symbols = await redisService.getAllGlobalStocks();
    console.log("Preloading close prices for:", symbols);
    for (let symbol of symbols) {
      await fetchLastClose(symbol);
    }
    console.log("Preloading complete.");

    socketService.init(server);
    server.listen(config.port, () =>
      console.log(`Server running on port ${config.port}`)
    );
  })
  .catch((err) => console.error(err));
