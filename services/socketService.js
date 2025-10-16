// services/socketService.js - REFACTORED & OPTIMIZED

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const config = require("../config/config");
const Watchlist = require("../models/Watchlist");
const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const ioInstance = require("./ioInstance");
const alertService = require("./alertService");

const STATUSES = alertService.STATUSES;

function init(server) {
  const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    perMessageDeflate: false // Optimize performance
  });

  ioInstance.setIo(io);
  upstoxService.connect();

  // Authentication middleware
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error("Authentication error"));
    
    try {
      socket.user = jwt.verify(token, config.jwtSecret).user;
      next();
    } catch {
      next(new Error("Authentication error"));
    }
  });

  io.on("connection", async (socket) => {
    console.log(`✅ User connected: ${socket.user.id}`);
    socket.join(`user:${socket.user.id}`);

    const subscribed = new Set(await redisService.getUserStocks(socket.user.id));

    // Send cached ticks for subscribed stocks
    for (const symbol of subscribed) {
      socket.join(symbol);
      const lastTick = await redisService.getLastTick(symbol);
      if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
    }

    // Handle watchlist subscriptions
    const watchlist = await Watchlist.findOne({ user: socket.user.id }).lean();
    if (watchlist?.symbols) {
      await handleSymbolSubscriptions(socket, watchlist.symbols, subscribed);
    }

    // Handle alert subscriptions
    const alerts = await Alert.find({
      user: socket.user.id,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
    }).lean();
    
    const alertSymbols = [...new Set(alerts.map(a => a.instrument_key))];
    await handleSymbolSubscriptions(socket, alertSymbols.map(s => ({ instrument_key: s })), subscribed);

    // Socket event handlers
    socket.on("addStock", async (symbol) => handleAddStock(socket, symbol, subscribed));
    socket.on("removeStock", async (symbol) => handleRemoveStock(socket, symbol, subscribed));
    socket.on("disconnect", async () => handleDisconnect(socket));
  });
}

async function handleSymbolSubscriptions(socket, symbols, subscribed) {
  for (const item of symbols) {
    const symbol = typeof item === 'string' ? item : item.instrument_key;
    
    if (!subscribed.has(symbol)) {
      subscribed.add(symbol);
      await redisService.addUserToStock(socket.user.id, symbol);
      
      const count = await redisService.getStockUserCount(symbol);
      if (count === 1) {
        upstoxService.subscribe([symbol]);
        console.log(`🌐 First subscription to ${symbol}`);
        
        // Cache last close if not available
        if (!(await redisService.getLastTick(symbol))) {
          const lastClose = await upstoxService.fetchLastClose(symbol);
          if (lastClose) {
            await redisService.setLastTick(symbol, {
              fullFeed: { marketFF: { ltpc: { ltp: lastClose.close } } },
            });
          }
        }
      }
    }
    
    socket.join(symbol);
    const lastTick = await redisService.getLastTick(symbol);
    if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
  }
}

async function handleAddStock(socket, symbol, subscribed) {
  if (!subscribed.has(symbol)) {
    subscribed.add(symbol);
    await redisService.addUserToStock(socket.user.id, symbol);
    console.log(`📈 User ${socket.user.id} subscribed to ${symbol}`);

    const count = await redisService.getStockUserCount(symbol);
    if (count === 1) {
      upstoxService.subscribe([symbol]);
      console.log(`🌐 First global subscription to ${symbol}`);

      if (!(await redisService.getLastTick(symbol))) {
        const lastClose = await upstoxService.fetchLastClose(symbol);
        if (lastClose) {
          await redisService.setLastTick(symbol, {
            fullFeed: { marketFF: { ltpc: { ltp: lastClose.close } } },
          });
        }
      }
    }
  }
  
  socket.join(symbol);
  const lastTick = await redisService.getLastTick(symbol);
  if (lastTick) socket.emit("tick", { symbol, tick: lastTick });
}

async function handleRemoveStock(socket, symbol, subscribed) {
  if (subscribed.has(symbol)) {
    subscribed.delete(symbol);
    await redisService.removeUserFromStock(socket.user.id, symbol);
    console.log(`📉 User ${socket.user.id} unsubscribed from ${symbol}`);

    const count = await redisService.getStockUserCount(symbol);
    if (count === 0) {
      upstoxService.unsubscribe([symbol]);
      await redisService.removeStockFromGlobal(symbol);
      console.log(`❎ Last global unsubscription from ${symbol}`);
    }
  }
  socket.leave(symbol);
}

async function handleDisconnect(socket) {
  console.log(`❌ User disconnected: ${socket.user.id}`);
  socket.leave(`user:${socket.user.id}`);

  const io = ioInstance.getIo();
  const remainingSockets = await io.in(`user:${socket.user.id}`).fetchSockets();
  
  if (remainingSockets.length === 0) {
    await redisService.cleanupUser(socket.user.id);
    console.log(`🧹 Cleaned up data for user: ${socket.user.id}`);
  }
}

module.exports = {
  init,
  migrateAlerts: alertService.migrateAlerts,
  STATUSES
};
