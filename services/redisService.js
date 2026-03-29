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
const redisConfig = require("../config/redisConfig");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const client = new Redis(redisConfig);

// ── MISCONF helper — used throughout to suppress RDB-snapshot errors ──
function isMisconf(err) {
  return String(err?.message || "").includes("MISCONF");
}

client.on("error", (err) => {
  if (isMisconf(err)) return; // suppress MISCONF spam
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
// tickBuffer stores raw tick objects (for in-process reads)
// tickBufferJson stores pre-serialized JSON (avoids re-serializing on flush)
const tickBuffer = new Map();
const tickBufferJson = new Map();

function setLastTick(symbol, tick) {
  tickBuffer.set(symbol, tick);
  tickBufferJson.set(symbol, JSON.stringify(tick));
}

// TTL refresh: only refresh every 100 flushes (~25s at 250ms interval)
// instead of every single flush — saves one Redis command per flush
let flushCount = 0;
const TTL_REFRESH_INTERVAL = 100;

async function flushTickBuffer() {
  if (tickBufferJson.size === 0) return;

  // Swap buffers instead of spread+clear to avoid allocation
  const jsonEntries = tickBufferJson;
  // Re-create fresh maps for the next interval (cheaper than clone+clear)
  // Note: we intentionally do NOT clear tickBuffer here — it serves as
  // a read-through cache. It gets overwritten on next setLastTick call.

  const start = Date.now();
  try {
    const pipeline = client.pipeline();
    for (const [symbol, json] of jsonEntries) {
      pipeline.hset("stock:lastTick", symbol, json);
    }

    // Only refresh TTL periodically, not on every flush
    flushCount++;
    if (flushCount >= TTL_REFRESH_INTERVAL) {
      pipeline.expire("stock:lastTick", 86400);
      flushCount = 0;
    }

    await pipeline.exec();
    metrics.observe("redis_flush_latency_ms", Date.now() - start);
    metrics.inc("redis_flush_ticks", jsonEntries.size);
  } catch (err) {
    if (!String(err.message).includes("MISCONF")) {
      logger.error("Tick buffer flush error", { error: err.message });
    }
  }
  // Clear the JSON buffer after exec (not before, to preserve atomicity on error)
  jsonEntries.clear();
}

// 250ms flush interval: reduces Redis round-trips by 60% vs 100ms
// while keeping data freshness within acceptable bounds for tick display
const flushInterval = setInterval(flushTickBuffer, 250);
flushInterval.unref();

// ── Tick reads ──

async function getLastTick(symbol) {
  // In-memory buffer is authoritative while it has data
  const buffered = tickBuffer.get(symbol);
  if (buffered !== undefined) return buffered;
  const v = await client.hget("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
}

async function getLastTickBatch(symbols) {
  if (!symbols.length) return {};

  // Separate symbols into buffered vs needs-Redis
  const result = {};
  const redisSymbols = [];
  const redisIndices = [];
  for (let i = 0; i < symbols.length; i++) {
    const sym = symbols[i];
    const buffered = tickBuffer.get(sym);
    if (buffered !== undefined) {
      result[sym] = buffered;
    } else {
      redisSymbols.push(sym);
      redisIndices.push(i);
    }
  }

  // Only hit Redis for symbols not in the buffer
  if (redisSymbols.length) {
    const values = await client.hmget("stock:lastTick", ...redisSymbols);
    for (let i = 0; i < redisSymbols.length; i++) {
      if (values[i]) {
        try {
          result[redisSymbols[i]] = JSON.parse(values[i]);
        } catch {
          // skip malformed
        }
      }
    }
  }
  return result;
}

// ── Close price cache ──

async function setLastClosePrice(symbol, data) {
  try {
    const pipeline = client.pipeline();
    pipeline.hset("stock:lastClose", symbol, JSON.stringify(data));
    pipeline.expire("stock:lastClose", 86400);
    await pipeline.exec();
  } catch (err) {
    if (!isMisconf(err)) throw err;
    // MISCONF — skip write, data will be fetched fresh next time
  }
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

async function addUserToStockBatch(userId, symbols) {
  if (!symbols.length) return;
  const userIdStr = String(userId);
  const pipeline = client.pipeline();
  for (const symbol of symbols) {
    pipeline.sadd(`stock:${symbol}:users`, userIdStr);
    pipeline.sadd("global:stocks", symbol);
    pipeline.sadd(`user:${userIdStr}:stocks`, symbol);
  }
  await pipeline.exec();
}

async function getStockUserCountBatch(symbols) {
  if (!symbols.length) return [];
  const pipeline = client.pipeline();
  for (const symbol of symbols) {
    pipeline.scard(`stock:${symbol}:users`);
  }
  const results = await pipeline.exec();
  return results.map(([err, count]) => (err ? 0 : count));
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
let _isCleaningStaleStocks = false;
let _lastStaleCleanup = 0;
const STALE_CLEANUP_MIN_INTERVAL = 30_000; // 30s debounce

async function cleanupStaleStocks() {
  // Debounce: skip if already running or ran too recently
  const now = Date.now();
  if (_isCleaningStaleStocks || (now - _lastStaleCleanup) < STALE_CLEANUP_MIN_INTERVAL) return;
  _isCleaningStaleStocks = true;
  _lastStaleCleanup = now;

  try {
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
  } finally {
    _isCleaningStaleStocks = false;
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
  const toUnsubscribe = [];
  const globalRemovePipeline = client.pipeline();
  let hasGlobalRemoves = false;
  for (let i = 0; i < toRemove.length; i++) {
    const [, userCount] = checkResults[i * 2];
    const [, isPersistent] = checkResults[i * 2 + 1];
    if (userCount === 0 && isPersistent === 0) {
      toUnsubscribe.push(toRemove[i]);
      globalRemovePipeline.srem("global:stocks", toRemove[i]);
      globalRemovePipeline.del(`stock:${toRemove[i]}:users`);
      hasGlobalRemoves = true;
    }
  }
  if (toUnsubscribe.length) {
    upstoxService.unsubscribe(toUnsubscribe);
  }
  if (hasGlobalRemoves) {
    await globalRemovePipeline.exec();
  }
}

// ── Deep Redis memory cleanup (critical for 500MB limit) ──
// Removes stale symbol entries from stock:lastTick and stock:lastClose hashes
// that are no longer in global:stocks or persistent:stocks.
let _isDeepCleaning = false;

async function deepCleanupRedisMemory() {
  if (_isDeepCleaning) return;
  _isDeepCleaning = true;
  try {
    const [globalStocks, persistentStocks] = await Promise.all([
      getAllGlobalStocks(),
      getPersistentStocks(),
    ]);
    const activeSymbols = new Set([...globalStocks, ...persistentStocks]);

    // Clean stale entries from stock:lastTick hash (HSCAN avoids blocking on large hashes)
    const tickFields = [];
    let cursor = '0';
    do {
      const [nextCursor, fields] = await client.hscan("stock:lastTick", cursor, "COUNT", 500);
      cursor = nextCursor;
      for (let i = 0; i < fields.length; i += 2) {
        tickFields.push(fields[i]);
      }
    } while (cursor !== '0');
    const staleTicks = tickFields.filter((f) => !activeSymbols.has(f));
    if (staleTicks.length) {
      await client.hdel("stock:lastTick", ...staleTicks);
      logger.info(`Redis cleanup: removed ${staleTicks.length} stale tick entries`);
    }

    // Clean stale entries from stock:lastClose hash (HSCAN avoids blocking on large hashes)
    const closeFields = [];
    let closeCursor = '0';
    do {
      const [nextCursor, fields] = await client.hscan("stock:lastClose", closeCursor, "COUNT", 500);
      closeCursor = nextCursor;
      for (let i = 0; i < fields.length; i += 2) {
        closeFields.push(fields[i]);
      }
    } while (closeCursor !== '0');
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
  } finally {
    _isDeepCleaning = false;
  }
}

// ── Persistent stock management ──

async function addPersistentStock(symbol) {
  try {
    await client.sadd("persistent:stocks", symbol);
  } catch (err) {
    if (!isMisconf(err)) throw err;
  }
}

async function addPersistentStockBatch(symbols) {
  if (!symbols.length) return;
  try {
    await client.sadd("persistent:stocks", ...symbols);
  } catch (err) {
    if (!isMisconf(err)) throw err;
  }
}

async function removePersistentStock(symbol) {
  try {
    await client.srem("persistent:stocks", symbol);
  } catch (err) {
    if (!isMisconf(err)) throw err;
  }
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
  addUserToStockBatch,
  removeUserFromStock,
  getStockUserCount,
  getStockUserCountBatch,
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
  addPersistentStockBatch,
  removePersistentStock,
  getPersistentStocks,
  shouldSubscribe,
  filterSubscribable,
  deleteKeysByPattern,
  deepCleanupRedisMemory,
};
