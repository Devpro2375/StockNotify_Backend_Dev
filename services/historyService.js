// services/historyService.js
// REFACTORED: Cached token lookup to avoid N MongoDB queries per history request,
// added metrics for cache hit/miss tracking.

const axios = require("axios");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

const { redis: redisClient } = require("./redisService");

// ── Cached access token (refreshed every 5 min) ──
let cachedToken = null;
let tokenCacheExpiry = 0;
const TOKEN_CACHE_TTL = 5 * 60 * 1000;

async function getToken() {
  if (cachedToken && Date.now() < tokenCacheExpiry) return cachedToken;
  const tokenDoc = await AccessToken.findOne().lean();
  if (!tokenDoc?.token) throw new Error("No access token found in database");
  cachedToken = tokenDoc.token;
  tokenCacheExpiry = Date.now() + TOKEN_CACHE_TTL;
  return cachedToken;
}

function nowInIST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }),
  );
}

function isNSEOpen() {
  const now = nowInIST();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return totalMinutes >= 555 && totalMinutes <= 930; // 09:15 - 15:30
}

function getUpstoxIntervalParams(interval) {
  // Upstox standard timeframes: 1, 5, 15, 30, 60, 120 minutes + day/week/month
  // App uses 75 for 1H and 125 for 2H — map to Upstox's 60 and 120
  const mapping = {
    1:   { unit: "minutes", interval: "1" },
    5:   { unit: "minutes", interval: "5" },
    15:  { unit: "minutes", interval: "15" },
    25:  { unit: "minutes", interval: "30" },   // no 25min on Upstox, use 30
    30:  { unit: "minutes", interval: "30" },
    75:  { unit: "minutes", interval: "60" },   // 1H = 60min on Upstox
    125: { unit: "minutes", interval: "120" },  // 2H = 120min on Upstox
    day:   { unit: "days",   interval: "1" },
    week:  { unit: "weeks",  interval: "1" },
    month: { unit: "months", interval: "1" },
  };
  return mapping[interval] || { unit: "days", interval: "1" };
}

async function fetchIntradayCandles(instrumentKey, interval, token) {
  try {
    const { unit, interval: intervalValue } = getUpstoxIntervalParams(interval);
    if (unit !== "minutes") return [];

    const baseUrl =
      config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
    const encodedKey = encodeURIComponent(instrumentKey);
    const url = `${baseUrl}/v3/historical-candle/intraday/${encodedKey}/${unit}/${intervalValue}`;

    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 10000,
    });

    const candles = response.data?.data?.candles || [];
    return candles.map((c) => ({
      time:
        typeof c[0] === "number" ? new Date(c[0] * 1000).toISOString() : c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseInt(c[5] || 0, 10),
    }));
  } catch (err) {
    logger.error("Error fetching intraday candles", { error: err.message });
    return [];
  }
}

async function fetchHistoricalCandles(instrumentKey, interval, token) {
  const baseUrl =
    config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
  const encodedKey = encodeURIComponent(instrumentKey);
  const { unit, interval: intervalValue } = getUpstoxIntervalParams(interval);

  const today = new Date().toISOString().slice(0, 10);

  // INDEX instruments (NSE_INDEX, BSE_INDEX) have stricter date limits on Upstox
  const isIndex = instrumentKey.includes("INDEX");

  const daysBackMap = isIndex
    ? {
        // INDEX limits — much tighter
        1: 30, 5: 30, 15: 30, 25: 30, 30: 30,
        75: 30, 125: 30,
        day: 365, week: 1825, month: 3650,
      }
    : {
        // EQUITY limits — normal
        1: 30, 5: 30, 15: 30, 25: 30, 30: 365,
        75: 365, 125: 365,
        day: 730, week: 1825, month: 3650,
      };
  const daysBack = daysBackMap[interval] || 30;

  // Try with calculated date range. If Upstox returns 400 (Invalid date range),
  // retry with progressively smaller ranges.
  const retryDays = [daysBack, Math.floor(daysBack / 2), Math.floor(daysBack / 4), 7];
  const isDaily = unit === "days" || unit === "weeks" || unit === "months";

  for (const tryDays of retryDays) {
    if (tryDays < 1) continue;

    const tryFrom = new Date();
    tryFrom.setDate(tryFrom.getDate() - tryDays);
    const tryFromStr = tryFrom.toISOString().slice(0, 10);
    const url = `${baseUrl}/v3/historical-candle/${encodedKey}/${unit}/${intervalValue}/${today}/${tryFromStr}`;

    try {
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        timeout: 15000,
      });

      const candles = response.data?.data?.candles || [];
      if (!candles.length) continue;

      return candles.map((c) => {
        let timeValue;
        if (isDaily) {
          timeValue =
            typeof c[0] === "number"
              ? new Date(c[0] * 1000).toISOString().split("T")[0]
              : String(c[0]).split("T")[0];
        } else {
          timeValue =
            typeof c[0] === "number" ? new Date(c[0] * 1000).toISOString() : c[0];
        }
        return {
          time: timeValue,
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseInt(c[5] || 0, 10),
        };
      });
    } catch (err) {
      const status = err.response?.status;
      if (status === 400) {
        // Invalid date range — try smaller range
        logger.warn(`Upstox 400 for ${instrumentKey} (${unit}/${intervalValue}) with ${tryDays}d, retrying smaller...`);
        continue;
      }
      if (status === 401) {
        logger.error("Access token expired in fetchHistoricalCandles");
        throw new Error("Access token expired");
      }
      logger.error(`Error fetching historical candles for ${instrumentKey}`, {
        error: err.message,
        status,
      });
      return [];
    }
  }

  logger.warn(`All date ranges exhausted for ${instrumentKey} (${unit}/${intervalValue})`);
  return [];
}

async function cacheHistoricalData(instrumentKey, interval) {
  const cacheKey = `history:${instrumentKey}:${interval}`;

  try {
    let cached = null;
    try {
      cached = await redisClient.get(cacheKey);
    } catch (cacheReadErr) {
      // MISCONF or other Redis read failure — fall through to API fetch
      if (!String(cacheReadErr.message).includes("MISCONF")) {
        logger.warn(`Redis read error for ${cacheKey}`, { error: cacheReadErr.message });
      }
    }

    if (cached) {
      metrics.inc("history_cache_hits");
      try {
        const ttl = await redisClient.ttl(cacheKey);
        const marketOpen = isNSEOpen();
        const maxTtl = marketOpen ? 120 : 3600;
        if (ttl > 0 && ttl < maxTtl / 2) {
          refreshCacheInBackground(instrumentKey, interval, cacheKey);
        }
      } catch {
        // TTL check failed — non-critical, continue with cached data
      }
      return JSON.parse(cached);
    }

    metrics.inc("history_cache_misses");
    return await fetchAndCache(instrumentKey, interval, cacheKey);
  } catch (err) {
    logger.error(`Error in cacheHistoricalData for ${instrumentKey}`, {
      error: err.message,
    });
    if (err.response?.status === 401) throw new Error("Access token expired");
    if (err.response?.status === 404) throw new Error("Instrument not found");
    throw err;
  }
}

async function fetchAndCache(instrumentKey, interval, cacheKey) {
  const token = await getToken();
  const marketOpen = isNSEOpen();
  const { unit } = getUpstoxIntervalParams(interval);

  const [historicalCandles, intradayCandles] = await Promise.all([
    fetchHistoricalCandles(instrumentKey, interval, token),
    marketOpen && unit === "minutes"
      ? fetchIntradayCandles(instrumentKey, interval, token)
      : Promise.resolve([]),
  ]);

  let allCandles = [...historicalCandles, ...intradayCandles];
  allCandles.sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
  );

  const seen = new Set();
  allCandles = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  const cacheDuration = marketOpen ? 120 : 3600;
  try {
    await redisClient.setex(cacheKey, cacheDuration, JSON.stringify(allCandles));
  } catch (cacheWriteErr) {
    // MISCONF or other Redis write failure — data is still returned to caller
    if (!String(cacheWriteErr.message).includes("MISCONF")) {
      logger.warn(`Redis write error for ${cacheKey}`, { error: cacheWriteErr.message });
    }
  }

  return allCandles;
}

function refreshCacheInBackground(instrumentKey, interval, cacheKey) {
  fetchAndCache(instrumentKey, interval, cacheKey).catch((err) => {
    logger.warn(
      `Background cache refresh failed for ${instrumentKey}:${interval}`,
      { error: err.message },
    );
  });
}

function invalidateTokenCache() {
  cachedToken = null;
  tokenCacheExpiry = 0;
}

module.exports = { cacheHistoricalData, invalidateTokenCache };
