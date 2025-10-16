// services/redisService.js - REFACTORED & OPTIMIZED

const redis = require("redis");
const config = require("../config/config");

const client = redis.createClient({
  socket: { 
    host: config.redisHost, 
    port: config.redisPort,
    reconnectStrategy: (retries) => Math.min(retries * 50, 500)
  },
  password: config.redisPassword
});

client.on("error", (err) => console.error("Redis Client Error:", err.message));
client.on("connect", () => console.log("✅ Redis connected"));
client.connect();

// Memory monitoring (optimized interval)
setInterval(async () => {
  try {
    const info = await client.info('memory');
    const usedMemory = info.match(/used_memory_human:(.+)/)?.[1];
    console.log(`Redis Memory: ${usedMemory}`);
  } catch (err) {
    console.error('Memory monitoring error:', err.message);
  }
}, 300000); // Every 5 minutes instead of 1

// ------------------- PIPELINE HELPERS -------------------
async function executePipeline(commands) {
  const pipeline = client.multi();
  commands.forEach(cmd => pipeline[cmd.method](...cmd.args));
  return await pipeline.exec();
}

// ------------------- USER-STOCK MANAGEMENT -------------------
exports.addUserToStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  await executePipeline([
    { method: 'sAdd', args: [`stock:${symbol}:users`, userIdStr] },
    { method: 'sAdd', args: ["global:stocks", symbol] },
    { method: 'sAdd', args: [`user:${userIdStr}:stocks`, symbol] }
  ]);
};

exports.removeUserFromStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  await executePipeline([
    { method: 'sRem', args: [`stock:${symbol}:users`, userIdStr] },
    { method: 'sRem', args: [`user:${userIdStr}:stocks`, symbol] }
  ]);
};

exports.getStockUserCount = async (symbol) => 
  await client.sCard(`stock:${symbol}:users`);

exports.removeStockFromGlobal = async (symbol) => {
  await executePipeline([
    { method: 'sRem', args: ["global:stocks", symbol] },
    { method: 'del', args: [`stock:${symbol}:users`] }
  ]);
};

exports.getUserStocks = async (userId) => 
  await client.sMembers(`user:${String(userId)}:stocks`);

exports.getAllGlobalStocks = async () => 
  await client.sMembers("global:stocks");

exports.getStockUsers = async (symbol) => 
  await client.sMembers(`stock:${symbol}:users`);

// ------------------- CLEANUP OPERATIONS -------------------
exports.cleanupStaleStocks = async () => {
  const all = await exports.getAllGlobalStocks();
  const commands = [];
  
  for (const sym of all) {
    if (await exports.getStockUserCount(sym) === 0) {
      commands.push(
        { method: 'sRem', args: ["global:stocks", sym] },
        { method: 'del', args: [`stock:${sym}:users`] }
      );
    }
  }
  
  if (commands.length > 0) {
    await executePipeline(commands);
  }
};

exports.cleanupUser = async (userId) => {
  const userIdStr = String(userId);
  const userStocks = await exports.getUserStocks(userId);
  const Alert = require("../models/Alert");
  const commands = [];

  for (const sym of userStocks) {
    const alerts = await Alert.find({ 
      user: userId, 
      instrument_key: sym, 
      status: "active" 
    }).lean().limit(1);
    
    if (alerts.length > 0) continue;

    commands.push(
      { method: 'sRem', args: [`stock:${sym}:users`, userIdStr] },
      { method: 'sRem', args: [`user:${userIdStr}:stocks`, sym] }
    );

    if (await exports.getStockUserCount(sym) === 0) {
      require("./upstoxService").unsubscribe([sym]);
      commands.push(
        { method: 'sRem', args: ["global:stocks", sym] },
        { method: 'del', args: [`stock:${sym}:users`] }
      );
    }
  }

  if (commands.length > 0) {
    await executePipeline(commands);
  }
};

// ------------------- TICK & PRICE CACHING -------------------
exports.setLastTick = async (symbol, tick) => {
  await client.hSet("stock:lastTick", symbol, JSON.stringify(tick));
  await client.expire("stock:lastTick", 86400); // Expire after 24 hour to prevent OOM
};

exports.getLastTick = async (symbol) => {
  const v = await client.hGet("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
};

exports.setLastClosePrice = async (symbol, data) => {
  await client.hSet("stock:lastClose", symbol, JSON.stringify(data));
  await client.expire("stock:lastClose", 86400);
};

exports.getLastClosePrice = async (symbol) => {
  const v = await client.hGet("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
};

// ------------------- PERSISTENT STOCKS -------------------
exports.addPersistentStock = async (symbol) => 
  await client.sAdd("persistent:stocks", symbol);

exports.removePersistentStock = async (symbol) => 
  await client.sRem("persistent:stocks", symbol);

exports.getPersistentStocks = async () => 
  await client.sMembers("persistent:stocks");

exports.shouldSubscribe = async (symbol) => {
  const [userCount, isPersistent] = await Promise.all([
    exports.getStockUserCount(symbol),
    client.sIsMember("persistent:stocks", symbol)
  ]);
  return userCount > 0 || isPersistent;
};

exports.redis = client;
