// services/historyService.js

const axios = require("axios");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");

// Reuse shared Redis client from redisService (no duplicate connections)
const { redis: redisClient } = require("./redisService");

// Get Date in IST
function nowInIST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
}

// NSE timings in IST: 09:15 – 15:30 (Mon–Fri)
function isNSEOpen() {
  const now = nowInIST();
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const marketStart = 9 * 60 + 15;
  const marketEnd = 15 * 60 + 30;

  return totalMinutes >= marketStart && totalMinutes <= marketEnd;
}

// Map custom intervals to Upstox V3 format
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

// Fetch TODAY'S intraday candles (V3 Intraday API)
async function fetchIntradayCandles(instrumentKey, interval, token) {
  try {
    const { unit, interval: intervalValue } = getUpstoxIntervalParams(interval);
    if (unit === "days" || unit === "weeks" || unit === "months") {
      return [];
    }

    const baseUrl =
      config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
    const encodedKey = encodeURIComponent(instrumentKey);

    const intradayUrl = `${baseUrl}/v3/historical-candle/intraday/${encodedKey}/${unit}/${intervalValue}`;
    const response = await axios.get(intradayUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 10000,
    });

    const candles = response.data?.data?.candles || [];
    if (!candles.length) return [];

    return candles.map((c) => {
      const timestamp = c[0];
      const isoTime =
        typeof timestamp === "number"
          ? new Date(timestamp * 1000).toISOString()
          : timestamp;

      return {
        time: isoTime,
        open: parseFloat(c[1]),
        high: parseFloat(c[2]),
        low: parseFloat(c[3]),
        close: parseFloat(c[4]),
        volume: parseInt(c[5] || 0, 10),
      };
    });
  } catch (err) {
    console.error("❌ Error fetching intraday candles:", err.message);
    return [];
  }
}

// Fetch HISTORICAL candles (V3 Historical API)
async function fetchHistoricalCandles(instrumentKey, interval, token) {
  try {
    const baseUrl =
      config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
    const encodedKey = encodeURIComponent(instrumentKey);
    const { unit, interval: intervalValue } = getUpstoxIntervalParams(interval);

    const today = new Date().toISOString().slice(0, 10);

    let daysBack = 30;
    switch (interval) {
      case "1":
      case "5":
      case "15":
      case "25":
      case "30":
        daysBack = 30;
        break;
      case "75":
      case "125":
        daysBack = 90;
        break;
      case "day":
        daysBack = 730;
        break;
      case "week":
        daysBack = 1825;
        break;
      case "month":
        daysBack = 3650;
        break;
      default:
        break;
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const from = fromDate.toISOString().slice(0, 10);

    const historicalUrl = `${baseUrl}/v3/historical-candle/${encodedKey}/${unit}/${intervalValue}/${today}/${from}`;

    const response = await axios.get(historicalUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });

    const candles = response.data?.data?.candles || [];
    if (!candles.length) {
      console.warn(
        `⚠️ No historical candles for ${instrumentKey} (${unit}/${intervalValue})`
      );
      return [];
    }

    return candles.map((c) => {
      const timestamp = c[0];
      let timeValue;
      if (unit === "days" || unit === "weeks" || unit === "months") {
        timeValue =
          typeof timestamp === "number"
            ? new Date(timestamp * 1000).toISOString().split("T")[0]
            : String(timestamp).split("T")[0];
      } else {
        timeValue =
          typeof timestamp === "number"
            ? new Date(timestamp * 1000).toISOString()
            : timestamp;
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
    console.error(`❌ Error fetching historical candles:`, err.message);
    throw err;
  }
}

// Main: cache BOTH historical + intraday data
// Uses stale-while-revalidate: serve cached instantly, refresh in background
async function cacheHistoricalData(instrumentKey, interval) {
  const cacheKey = `history:${instrumentKey}:${interval}`;

  try {
    // Check cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      // Stale-while-revalidate: check TTL remaining
      const ttl = await redisClient.ttl(cacheKey);
      const marketOpen = isNSEOpen();
      const maxTtl = marketOpen ? 120 : 3600;

      // If cache is past half-life, refresh in background (non-blocking)
      if (ttl > 0 && ttl < maxTtl / 2) {
        refreshCacheInBackground(instrumentKey, interval, cacheKey, maxTtl);
      }

      return JSON.parse(cached);
    }

    // No cache — fetch fresh
    return await fetchAndCache(instrumentKey, interval, cacheKey);
  } catch (err) {
    console.error(
      `❌ Error in cacheHistoricalData for ${instrumentKey}:`,
      err.message
    );
    if (err.response?.status === 401) throw new Error("Access token expired");
    if (err.response?.status === 404) throw new Error("Instrument not found");
    throw err;
  }
}

// Shared fetch + cache logic
async function fetchAndCache(instrumentKey, interval, cacheKey) {
  const tokenDoc = await AccessToken.findOne().lean();
  if (!tokenDoc?.token) throw new Error("No access token found in database");

  const marketOpen = isNSEOpen();
  const { unit } = getUpstoxIntervalParams(interval);

  const [historicalCandles, intradayCandles] = await Promise.all([
    fetchHistoricalCandles(instrumentKey, interval, tokenDoc.token),
    marketOpen && unit === "minutes"
      ? fetchIntradayCandles(instrumentKey, interval, tokenDoc.token)
      : Promise.resolve([]),
  ]);

  // Merge + sort + de-duplicate
  let allCandles = [...historicalCandles, ...intradayCandles];
  allCandles.sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
  const seen = new Set();
  allCandles = allCandles.filter((c) => {
    if (seen.has(c.time)) return false;
    seen.add(c.time);
    return true;
  });

  // Cache with TTL: 120s during market hours, 1 hour after close
  const cacheDuration = marketOpen ? 120 : 3600;
  await redisClient.setEx(
    cacheKey,
    cacheDuration,
    JSON.stringify(allCandles)
  );

  return allCandles;
}

// Background refresh — fire-and-forget, never throws to caller
function refreshCacheInBackground(instrumentKey, interval, cacheKey, maxTtl) {
  fetchAndCache(instrumentKey, interval, cacheKey).catch((err) => {
    console.warn(
      `⚠️ Background cache refresh failed for ${instrumentKey}:${interval}:`,
      err.message
    );
  });
}

module.exports = { cacheHistoricalData };
