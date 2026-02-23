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
  const mapping = {
    1: { unit: "minutes", interval: "1" },
    5: { unit: "minutes", interval: "5" },
    15: { unit: "minutes", interval: "15" },
    25: { unit: "minutes", interval: "25" },
    30: { unit: "minutes", interval: "30" },
    75: { unit: "minutes", interval: "75" },
    125: { unit: "minutes", interval: "125" },
    day: { unit: "days", interval: "1" },
    week: { unit: "weeks", interval: "1" },
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
  const daysBackMap = {
    1: 30,
    5: 30,
    15: 30,
    25: 30,
    30: 30,
    75: 90,
    125: 90,
    day: 730,
    week: 1825,
    month: 3650,
  };
  const daysBack = daysBackMap[interval] || 30;

  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - daysBack);
  const from = fromDate.toISOString().slice(0, 10);

  const url = `${baseUrl}/v3/historical-candle/${encodedKey}/${unit}/${intervalValue}/${today}/${from}`;
  const response = await axios.get(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    timeout: 15000,
  });

  const candles = response.data?.data?.candles || [];
  if (!candles.length) {
    logger.warn(
      `No historical candles for ${instrumentKey} (${unit}/${intervalValue})`,
    );
    return [];
  }

  const isDaily = unit === "days" || unit === "weeks" || unit === "months";
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
}

async function cacheHistoricalData(instrumentKey, interval) {
  const cacheKey = `history:${instrumentKey}:${interval}`;

  try {
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      metrics.inc("history_cache_hits");
      const ttl = await redisClient.ttl(cacheKey);
      const marketOpen = isNSEOpen();
      const maxTtl = marketOpen ? 120 : 3600;

      if (ttl > 0 && ttl < maxTtl / 2) {
        refreshCacheInBackground(instrumentKey, interval, cacheKey);
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
  await redisClient.setex(cacheKey, cacheDuration, JSON.stringify(allCandles));

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

module.exports = { cacheHistoricalData };
