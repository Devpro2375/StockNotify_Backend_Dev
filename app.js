const express = require("express");
const mongoose = require("mongoose");
const http = require("http");
const cors = require("cors");
const config = require("./config/config");
const socketService = require("./services/socketService");
const authRoutes = require("./routes/authRoutes");
const watchlistRoutes = require("./routes/watchlistRoutes");
const redisService = require("./services/redisService");
const { fetchLastClose } = require("./services/upstoxService");

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*" }));
app.use(express.json());

app.use("/api/auth", authRoutes);
app.use("/api/watchlist", watchlistRoutes);

mongoose
  .connect(config.mongoURI)
  .then(async () => {
    console.log("MongoDB connected");

    // Cleanup any stale stocks
    await redisService.cleanupStaleStocks();

    // Preload last close for all active symbols
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
