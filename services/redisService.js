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

// Periodic TTL refresh for hash keys (instead of per-tick expire calls)
setInterval(async () => {
  try {
    await client.expire("stock:lastTick", 86400);
    await client.expire("stock:lastClose", 86400);
  } catch (err) {
    console.error("Redis TTL refresh error:", err.message);
  }
}, 60 * 1000); // every 1 minute

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

// Expose client for shared access (historyService uses this)
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

// Fixed: no longer mixes await inside pipeline (was causing non-atomic behavior)
exports.cleanupStaleStocks = async () => {
  const all = await exports.getAllGlobalStocks();
  const toRemove = [];
  for (const sym of all) {
    if ((await exports.getStockUserCount(sym)) === 0) {
      toRemove.push(sym);
    }
  }
  if (toRemove.length) {
    const pipeline = client.multi();
    for (const sym of toRemove) {
      pipeline.sRem("global:stocks", sym);
      pipeline.del(`stock:${sym}:users`);
    }
    await pipeline.exec();
    console.log(`🧹 Cleaned ${toRemove.length} stale stocks from global set`);
  }
};

exports.cleanupUser = async (userId) => {
  const userIdStr = String(userId);
  const userStocks = await exports.getUserStocks(userId);
  const toRemove = [];

  for (const sym of userStocks) {
    const alerts = await require("../models/Alert").countDocuments({
      user: userId,
      instrument_key: sym,
      status: { $nin: ["slHit", "targetHit"] },
    });
    if (alerts > 0) continue;
    toRemove.push(sym);
  }

  if (toRemove.length) {
    const pipeline = client.multi();
    for (const sym of toRemove) {
      pipeline.sRem(`stock:${sym}:users`, userIdStr);
      pipeline.sRem(`user:${userIdStr}:stocks`, sym);
    }
    await pipeline.exec();

    // Only unsubscribe if no users AND no active alerts (persistent stocks)
    for (const sym of toRemove) {
      if (!(await exports.shouldSubscribe(sym))) {
        require("./upstoxService").unsubscribe([sym]);
        await exports.removeStockFromGlobal(sym);
      }
    }
  }
};

// ── Tick cache — no per-write expire (handled by periodic TTL above) ──
exports.setLastTick = async (symbol, tick) => {
  await client.hSet("stock:lastTick", symbol, JSON.stringify(tick));
};

exports.getLastTick = async (symbol) => {
  const v = await client.hGet("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
};

// Batch tick retrieval — single Redis round-trip for N symbols
exports.getLastTickBatch = async (symbols) => {
  if (!symbols.length) return {};
  const values = await client.hmGet("stock:lastTick", symbols);
  const result = {};
  for (let i = 0; i < symbols.length; i++) {
    if (values[i]) {
      try {
        result[symbols[i]] = JSON.parse(values[i]);
      } catch {
        // skip malformed entries
      }
    }
  }
  return result;
};

// ── Close price cache — no per-write expire ──
exports.setLastClosePrice = async (symbol, data) => {
  await client.hSet("stock:lastClose", symbol, JSON.stringify(data));
};

exports.getLastClosePrice = async (symbol) => {
  const v = await client.hGet("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
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
