// services/redisService.js
// ──────────────────────────────────────────────────────────────
// REFACTORED: Optimized Redis operations
//  1. Pipeline shouldSubscribe/filterSubscribable for batch checks
//  2. cleanupStaleStocks uses pipeline SCARD instead of N sequential calls
//  3. cleanupUser uses single aggregate query instead of N countDocuments
//  4. Removed redundant TTL refresh interval (TTL set on flush instead)
//  5. All intervals use .unref() to not prevent process exit
//  6. Memory monitoring reduced to avoid log spam
// ──────────────────────────────────────────────────────────────

const Redis = require("ioredis");
const config = require("../config/config");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const redisConfig = {
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword,
  maxRetriesPerRequest: null, // required by Bull
  enableReadyCheck: false,
};

const client = new Redis(redisConfig);

client.on("error", (err) => {
  // Suppress MISCONF spam
  if (String(err.message).includes("MISCONF")) return;
  logger.error("Redis Client Error", { error: err.message });
});
client.on("connect", () => logger.info("Redis connected"));

// ── Memory monitoring (every 5 min) ──
const memInterval = setInterval(async () => {
  try {
    const info = await client.info("memory");
    const usedHuman = (info.match(/used_memory_human:(.*)\r?\n/) || [])[1] || "unknown";
    metrics.gauge("redis_memory", usedHuman.trim());
  } catch {
    // silent
  }
}, 5 * 60 * 1000);
memInterval.unref();

// ═══════════════════════════════════════════════════
// WRITE-COALESCING TICK BUFFER
// ═══════════════════════════════════════════════════
const tickBuffer = new Map();

function setLastTick(symbol, tick) {
  tickBuffer.set(symbol, tick);
}

async function flushTickBuffer() {
  if (tickBuffer.size === 0) return;
  const entries = [...tickBuffer.entries()];
  tickBuffer.clear();

  const start = Date.now();
  try {
    const pipeline = client.pipeline();
    for (const [symbol, tick] of entries) {
      pipeline.hset("stock:lastTick", symbol, JSON.stringify(tick));
    }
    // Refresh TTL on the hash key during flush (replaces separate interval)
    pipeline.expire("stock:lastTick", 86400);
    await pipeline.exec();
    metrics.observe("redis_flush_latency_ms", Date.now() - start);
    metrics.inc("redis_flush_ticks", entries.length);
  } catch (err) {
    if (!String(err.message).includes("MISCONF")) {
      logger.error("Tick buffer flush error", { error: err.message });
    }
  }
}

const flushInterval = setInterval(flushTickBuffer, 100);
flushInterval.unref();

// ── Tick reads ──

async function getLastTick(symbol) {
  if (tickBuffer.has(symbol)) return tickBuffer.get(symbol);
  const v = await client.hget("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
}

async function getLastTickBatch(symbols) {
  if (!symbols.length) return {};
  const values = await client.hmget("stock:lastTick", ...symbols);
  const result = {};
  for (let i = 0; i < symbols.length; i++) {
    if (tickBuffer.has(symbols[i])) {
      result[symbols[i]] = tickBuffer.get(symbols[i]);
    } else if (values[i]) {
      try {
        result[symbols[i]] = JSON.parse(values[i]);
      } catch {
        // skip malformed
      }
    }
  }
  return result;
}

// ── Close price cache ──

async function setLastClosePrice(symbol, data) {
  const pipeline = client.pipeline();
  pipeline.hset("stock:lastClose", symbol, JSON.stringify(data));
  pipeline.expire("stock:lastClose", 86400);
  await pipeline.exec();
}

async function getLastClosePrice(symbol) {
  const v = await client.hget("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
}

async function getLastClosePriceBatch(symbols) {
  if (!symbols.length) return {};
  const values = await client.hmget("stock:lastClose", ...symbols);
  const result = {};
  for (let i = 0; i < symbols.length; i++) {
    if (values[i]) {
      try {
        result[symbols[i]] = JSON.parse(values[i]);
      } catch {
        // skip malformed
      }
    }
  }
  return result;
}

// ── User-Stock associations ──

async function addUserToStock(userId, symbol) {
  const userIdStr = String(userId);
  const pipeline = client.pipeline();
  pipeline.sadd(`stock:${symbol}:users`, userIdStr);
  pipeline.sadd("global:stocks", symbol);
  pipeline.sadd(`user:${userIdStr}:stocks`, symbol);
  await pipeline.exec();
}

async function removeUserFromStock(userId, symbol) {
  const userIdStr = String(userId);
  const pipeline = client.pipeline();
  pipeline.srem(`stock:${symbol}:users`, userIdStr);
  pipeline.srem(`user:${userIdStr}:stocks`, symbol);
  await pipeline.exec();
}

async function getStockUserCount(symbol) {
  return client.scard(`stock:${symbol}:users`);
}

async function removeStockFromGlobal(symbol) {
  const pipeline = client.pipeline();
  pipeline.srem("global:stocks", symbol);
  pipeline.del(`stock:${symbol}:users`);
  await pipeline.exec();
}

async function getUserStocks(userId) {
  return client.smembers(`user:${String(userId)}:stocks`);
}

async function getAllGlobalStocks() {
  return client.smembers("global:stocks");
}

async function getStockUsers(symbol) {
  return client.smembers(`stock:${symbol}:users`);
}

async function deleteUserStockSet(userId) {
  const userIdStr = String(userId);
  const userStocks = await getUserStocks(userId);
  if (!userStocks.length) return;

  const pipeline = client.pipeline();
  for (const sym of userStocks) {
    pipeline.srem(`stock:${sym}:users`, userIdStr);
  }
  pipeline.del(`user:${userIdStr}:stocks`);
  await pipeline.exec();
}

// ── Optimized cleanup: pipeline SCARD instead of N sequential calls ──
async function cleanupStaleStocks() {
  const all = await getAllGlobalStocks();
  if (!all.length) return;

  // Batch SCARD via pipeline
  const pipeline = client.pipeline();
  for (const sym of all) {
    pipeline.scard(`stock:${sym}:users`);
  }
  const results = await pipeline.exec();

  const toRemove = [];
  for (let i = 0; i < all.length; i++) {
    const [err, count] = results[i];
    if (!err && count === 0) {
      toRemove.push(all[i]);
    }
  }

  if (toRemove.length) {
    const cleanPipeline = client.pipeline();
    for (const sym of toRemove) {
      cleanPipeline.srem("global:stocks", sym);
      cleanPipeline.del(`stock:${sym}:users`);
    }
    await cleanPipeline.exec();
    logger.info(`Cleaned ${toRemove.length} stale stocks from global set`);
  }
}

// ── Optimized user cleanup: single aggregate instead of N countDocuments ──
async function cleanupUser(userId) {
  const userStocks = await getUserStocks(userId);
  if (!userStocks.length) return;

  // Single aggregate to find which symbols have active alerts for this user
  const Alert = require("../models/Alert");
  const activeSymbols = await Alert.distinct("instrument_key", {
    user: userId,
    instrument_key: { $in: userStocks },
    status: { $nin: ["slHit", "targetHit"] },
  });
  const activeSet = new Set(activeSymbols);

  const toRemove = userStocks.filter((sym) => !activeSet.has(sym));
  if (!toRemove.length) return;

  const userIdStr = String(userId);
  const pipeline = client.pipeline();
  for (const sym of toRemove) {
    pipeline.srem(`stock:${sym}:users`, userIdStr);
    pipeline.srem(`user:${userIdStr}:stocks`, sym);
  }
  await pipeline.exec();

  // Check which removed symbols can be fully unsubscribed
  const checkPipeline = client.pipeline();
  for (const sym of toRemove) {
    checkPipeline.scard(`stock:${sym}:users`);
    checkPipeline.sismember("persistent:stocks", sym);
  }
  const checkResults = await checkPipeline.exec();

  const upstoxService = require("./upstoxService");
  for (let i = 0; i < toRemove.length; i++) {
    const [, userCount] = checkResults[i * 2];
    const [, isPersistent] = checkResults[i * 2 + 1];
    if (userCount === 0 && isPersistent === 0) {
      upstoxService.unsubscribe([toRemove[i]]);
      await removeStockFromGlobal(toRemove[i]);
    }
  }
}

// ── Deep Redis memory cleanup (critical for 500MB limit) ──
// Removes stale symbol entries from stock:lastTick and stock:lastClose hashes
// that are no longer in global:stocks or persistent:stocks.
async function deepCleanupRedisMemory() {
  try {
    const [globalStocks, persistentStocks] = await Promise.all([
      getAllGlobalStocks(),
      getPersistentStocks(),
    ]);
    const activeSymbols = new Set([...globalStocks, ...persistentStocks]);

    // Clean stale entries from stock:lastTick hash
    const tickFields = await client.hkeys("stock:lastTick");
    const staleTicks = tickFields.filter((f) => !activeSymbols.has(f));
    if (staleTicks.length) {
      await client.hdel("stock:lastTick", ...staleTicks);
      logger.info(`Redis cleanup: removed ${staleTicks.length} stale tick entries`);
    }

    // Clean stale entries from stock:lastClose hash
    const closeFields = await client.hkeys("stock:lastClose");
    const staleCloses = closeFields.filter((f) => !activeSymbols.has(f));
    if (staleCloses.length) {
      await client.hdel("stock:lastClose", ...staleCloses);
      logger.info(`Redis cleanup: removed ${staleCloses.length} stale close price entries`);
    }

    // Clean orphaned stock:*:users sets (symbol not in global or persistent)
    const userSetKeys = await scanKeysByPattern("stock:*:users");
    const orphanedSets = userSetKeys.filter((key) => {
      const sym = key.replace("stock:", "").replace(":users", "");
      return !activeSymbols.has(sym);
    });
    if (orphanedSets.length) {
      await client.del(...orphanedSets);
      logger.info(`Redis cleanup: removed ${orphanedSets.length} orphaned user sets`);
    }

    // Clean expired history cache keys (should auto-expire via TTL, but safety net)
    const historyKeys = await scanKeysByPattern("history:*");
    if (historyKeys.length > 500) {
      // If too many history keys, check TTL and remove expired
      const pipeline = client.pipeline();
      for (const key of historyKeys) {
        pipeline.ttl(key);
      }
      const ttlResults = await pipeline.exec();
      const expired = [];
      for (let i = 0; i < historyKeys.length; i++) {
        const [, ttl] = ttlResults[i];
        if (ttl === -1) expired.push(historyKeys[i]); // no TTL set
      }
      if (expired.length) {
        await client.del(...expired);
        logger.info(`Redis cleanup: removed ${expired.length} history keys without TTL`);
      }
    }

    // Log memory after cleanup
    const info = await client.info("memory");
    const usedHuman = (info.match(/used_memory_human:(.*)\r?\n/) || [])[1] || "unknown";
    logger.info(`Redis memory after cleanup: ${usedHuman.trim()}`);
  } catch (err) {
    logger.error("Deep Redis cleanup error", { error: err.message });
  }
}

// ── Persistent stock management ──

async function addPersistentStock(symbol) {
  await client.sadd("persistent:stocks", symbol);
}

async function removePersistentStock(symbol) {
  await client.srem("persistent:stocks", symbol);
}

async function getPersistentStocks() {
  return client.smembers("persistent:stocks");
}

// Single-symbol check
async function shouldSubscribe(symbol) {
  const pipeline = client.pipeline();
  pipeline.scard(`stock:${symbol}:users`);
  pipeline.sismember("persistent:stocks", symbol);
  const results = await pipeline.exec();
  const [, userCount] = results[0];
  const [, isPersistent] = results[1];
  return userCount > 0 || isPersistent === 1;
}

// ── Batch check: returns array of symbols that need Upstox subscription ──
async function filterSubscribable(symbols) {
  if (!symbols.length) return [];
  const pipeline = client.pipeline();
  for (const sym of symbols) {
    pipeline.scard(`stock:${sym}:users`);
    pipeline.sismember("persistent:stocks", sym);
  }
  const results = await pipeline.exec();

  const subscribable = [];
  for (let i = 0; i < symbols.length; i++) {
    const [, userCount] = results[i * 2];
    const [, isPersistent] = results[i * 2 + 1];
    if (userCount > 0 || isPersistent === 1) {
      subscribable.push(symbols[i]);
    }
  }
  return subscribable;
}

// ── Utility ──

async function scanKeysByPattern(pattern) {
  const keys = [];
  const stream = client.scanStream({ match: pattern, count: 1000 });
  return new Promise((resolve, reject) => {
    stream.on("data", (batch) => keys.push(...batch));
    stream.on("end", () => resolve(keys));
    stream.on("error", reject);
  });
}

async function deleteKeysByPattern(pattern) {
  const keys = await scanKeysByPattern(pattern);
  if (keys.length) {
    await client.del(...keys);
  }
  return keys.length;
}

async function ping() {
  return client.ping();
}

async function quit() {
  return client.quit();
}

async function flushAndQuit() {
  clearInterval(flushInterval);
  await flushTickBuffer();
  return client.quit();
}

module.exports = {
  redis: client,
  redisConfig,
  ping,
  quit,
  flushAndQuit,
  addUserToStock,
  removeUserFromStock,
  getStockUserCount,
  removeStockFromGlobal,
  getUserStocks,
  getAllGlobalStocks,
  getStockUsers,
  deleteUserStockSet,
  cleanupStaleStocks,
  cleanupUser,
  setLastTick,
  getLastTick,
  getLastTickBatch,
  setLastClosePrice,
  getLastClosePrice,
  getLastClosePriceBatch,
  addPersistentStock,
  removePersistentStock,
  getPersistentStocks,
  shouldSubscribe,
  filterSubscribable,
  deleteKeysByPattern,
  deepCleanupRedisMemory,
};
