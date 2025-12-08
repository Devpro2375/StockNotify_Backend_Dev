// services/redisService.js

const redis = require("redis");
const config = require("../config/config");

const client = redis.createClient({
  socket: { host: config.redisHost, port: config.redisPort },
  password: config.redisPassword,
});

client.on("error", (err) => console.error("Redis Client Error", err));
client.connect();

// Memory monitoring (every 5 min; concise).
setInterval(async () => {
  try {
    const info = await client.info("memory");
    const usedHuman =
      (info.match(/used_memory_human:(.*)\r?\n/) || [])[1] || "unknown";
    console.log(`Redis Memory Usage: ${usedHuman}`);
  } catch (err) {
    console.error("Redis memory monitoring error:", err.message);
  }
}, 5 * 60 * 1000);

// ---------- Helpers ----------
async function scanKeysByPattern(pattern) {
  const keys = [];
  for await (const key of client.scanIterator({
    MATCH: pattern,
    COUNT: 1000,
  })) {
    keys.push(key);
  }
  return keys;
}

exports.ping = async () => client.ping();

// Expose client for rare direct access (compat layer)
exports.redis = client;

// Graceful quit
exports.quit = async () => client.quit();

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
  return client.sMembers(`user:${userIdStr}:stocks`);
};

exports.getAllGlobalStocks = async () => client.sMembers("global:stocks");
exports.getStockUsers = async (symbol) =>
  client.sMembers(`stock:${symbol}:users`);

exports.cleanupStaleStocks = async () => {
  const all = await exports.getAllGlobalStocks();
  const pipeline = client.multi();
  for (const sym of all) {
    if ((await exports.getStockUserCount(sym)) === 0) {
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
    const alerts = await require("../models/Alert").find({
      user: userId,
      instrument_key: sym,
      status: "active",
    });
    if (alerts.length > 0) continue;

    pipeline.sRem(`stock:${sym}:users`, userIdStr);
    pipeline.sRem(`user:${userIdStr}:stocks`, sym);
    if ((await exports.getStockUserCount(sym)) === 0) {
      require("./upstoxService").unsubscribe([sym]);
      pipeline.sRem("global:stocks", sym);
      pipeline.del(`stock:${sym}:users`);
    }
  }
  await pipeline.exec();
};

exports.setLastTick = async (symbol, tick) => {
  await client.hSet("stock:lastTick", symbol, JSON.stringify(tick));
  await client.expire("stock:lastTick", 86400); // expire hash in 1 day
};

exports.getLastTick = async (symbol) => {
  const v = await client.hGet("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
};

exports.setLastClosePrice = async (symbol, data) => {
  await client.hSet("stock:lastClose", symbol, JSON.stringify(data));
  await client.expire("stock:lastClose", 86400); // 1 day
};

exports.getLastClosePrice = async (symbol) => {
  const v = await client.hGet("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
};

exports.getManyLastClosePrices = async (symbols) => {
  if (!symbols || symbols.length === 0) return {};
  // hmGet returns array of values in same order as keys
  const values = await client.hmGet("stock:lastClose", symbols);
  const result = {};
  symbols.forEach((sym, i) => {
    result[sym] = values[i] ? JSON.parse(values[i]) : null;
  });
  return result;
};

exports.addPersistentStock = async (symbol) => {
  await client.sAdd("persistent:stocks", symbol);
};

exports.removePersistentStock = async (symbol) => {
  await client.sRem("persistent:stocks", symbol);
};

exports.getPersistentStocks = async () => client.sMembers("persistent:stocks");

exports.shouldSubscribe = async (symbol) => {
  const userCount = await exports.getStockUserCount(symbol);
  const isPersistent = await client.sIsMember("persistent:stocks", symbol);
  return userCount > 0 || isPersistent;
};

// Utility for instrument cache cleanup
exports.deleteKeysByPattern = async (pattern) => {
  const keys = await scanKeysByPattern(pattern);
  if (keys.length) {
    await client.del(keys);
  }
  return keys.length;
};

// ---------- Alert Caching ----------
exports.cacheAlert = async (alert) => {
  const key = `alerts:active:${alert.instrument_key}`;
  // Store alert as a field in a hash, where field name is alert ID
  await client.hSet(key, alert._id.toString(), JSON.stringify(alert));
};

exports.removeCachedAlert = async (instrumentKey, alertId) => {
  const key = `alerts:active:${instrumentKey}`;
  await client.hDel(key, alertId.toString());
};

exports.getCachedAlerts = async (instrumentKey) => {
  const key = `alerts:active:${instrumentKey}`;
  const alertsMap = await client.hGetAll(key);
  return Object.values(alertsMap).map((json) => JSON.parse(json));
};

exports.updateCachedAlert = async (alert) => {
  // Same as cacheAlert, overwrites existing field
  await exports.cacheAlert(alert);
};
