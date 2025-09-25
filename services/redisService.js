// services/redisService.js


const redis = require("redis");
const config = require("../config/config");

const client = redis.createClient({
  socket: { host: config.redisHost, port: config.redisPort },
  password: config.redisPassword
});
client.on("error", (err) => console.log("Redis Client Error", err));
client.connect();

// New: Monitor memory usage periodically
setInterval(async () => {
  try {
    const info = await client.info('memory');
    console.log('Redis Memory Usage:', info);
  } catch (err) {
    console.error('Memory monitoring error:', err);
  }
}, 60000); // Every minute

exports.addUserToStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  const pipeline = client.multi();
  pipeline.sAdd(`stock:${symbol}:users`, userIdStr);
  pipeline.sAdd("global:stocks", symbol);
  pipeline.sAdd(`user:${userIdStr}:stocks`, symbol);
  await pipeline.exec();
};

exports.removeUserFromStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  const pipeline = client.multi();
  pipeline.sRem(`stock:${symbol}:users`, userIdStr);
  pipeline.sRem(`user:${userIdStr}:stocks`, symbol);
  await pipeline.exec();
};

exports.getStockUserCount = async (symbol) =>
  client.sCard(`stock:${symbol}:users`);

exports.removeStockFromGlobal = async (symbol) => {
  const pipeline = client.multi();
  pipeline.sRem("global:stocks", symbol);
  pipeline.del(`stock:${symbol}:users`);
  await pipeline.exec();
};

exports.getUserStocks = async (userId) => {
  const userIdStr = String(userId);
  return await client.sMembers(`user:${userIdStr}:stocks`);
};

exports.getAllGlobalStocks = async () => await client.sMembers("global:stocks");

exports.getStockUsers = async (symbol) => await client.sMembers(`stock:${symbol}:users`);

exports.cleanupStaleStocks = async () => {
  const all = await exports.getAllGlobalStocks();
  const pipeline = client.multi();
  for (const sym of all) {
    if (await exports.getStockUserCount(sym) === 0) {
      pipeline.sRem("global:stocks", sym);
      pipeline.del(`stock:${sym}:users`);
    }
  }
  await pipeline.exec();
};

exports.cleanupUser = async (userId) => {
  const userIdStr = String(userId);
  const userStocks = await exports.getUserStocks(userId);
  const pipeline = client.multi();
  for (const sym of userStocks) {
    const alerts = await require("../models/Alert").find({ user: userId, instrument_key: sym, status: "active" });
    if (alerts.length > 0) continue;

    pipeline.sRem(`stock:${sym}:users`, userIdStr);
    pipeline.sRem(`user:${userIdStr}:stocks`, sym);
    if (await exports.getStockUserCount(sym) === 0) {
      require("./upstoxService").unsubscribe([sym]);
      pipeline.sRem("global:stocks", sym);
      pipeline.del(`stock:${sym}:users`);
    }
  }
  await pipeline.exec();
};

exports.setLastTick = async (symbol, tick) => {
  await client.hSet("stock:lastTick", symbol, JSON.stringify(tick));
  await client.expire("stock:lastTick", 3600); // Expire after 1 hour to prevent OOM
};

exports.getLastTick = async (symbol) => {
  const v = await client.hGet("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
};

exports.setLastClosePrice = async (symbol, data) => {
  await client.hSet("stock:lastClose", symbol, JSON.stringify(data));
  await client.expire("stock:lastClose", 86400); // Expire after 1 day
};

exports.getLastClosePrice = async (symbol) => {
  const v = await client.hGet("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
};

exports.addPersistentStock = async (symbol) => {
  await client.sAdd("persistent:stocks", symbol);
  // REMOVED: await client.expire("persistent:stocks", 86400); // Make persistent until explicitly removed
};

exports.removePersistentStock = async (symbol) => {
  await client.sRem("persistent:stocks", symbol);
};

exports.getPersistentStocks = async () => await client.sMembers("persistent:stocks");

// NEW: Check if a stock should be subscribed (global users OR persistent alerts)
exports.shouldSubscribe = async (symbol) => {
  const userCount = await exports.getStockUserCount(symbol);
  const isPersistent = await client.sIsMember("persistent:stocks", symbol);
  return userCount > 0 || isPersistent;
};
