// services/historyService.js

const redis = require("redis");
const axios = require("axios");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");

const redisClient = redis.createClient({
  socket: { host: config.redisHost, port: config.redisPort },
  password: config.redisPassword,
});
redisClient.connect();

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
  if (day === 0 || day === 6) return false; // Sunday/Saturday
  const hours = now.getHours();
  const minutes = now.getMinutes();
  const totalMinutes = hours * 60 + minutes;

  const marketStart = 9 * 60 + 15; // 9:15
  const marketEnd = 15 * 60 + 30; // 15:30

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
      // Skip intraday fetch for higher timeframes
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

    // Upstox returns [timestamp, open, high, low, close, volume, oi]
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
    if (err.response?.data) {
      console.error(
        "   API Error:",
        JSON.stringify(err.response.data, null, 2)
      );
    }
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
        daysBack = 730; // 2 years
        break;
      case "week":
        daysBack = 1825; // 5 years
        break;
      case "month":
        daysBack = 3650; // 10 years
        break;
      default:
        break;
    }

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - daysBack);
    const from = fromDate.toISOString().slice(0, 10);

    // NOTE: Upstox path ordering: .../{to}/{from}
    const historicalUrl = `${baseUrl}/v3/historical-candle/${encodedKey}/${unit}/${intervalValue}/${today}/${from}`;

    const response = await axios.get(historicalUrl, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });

    const candles = response.data?.data?.candles || [];
    if (!candles.length) {
      console.warn(
        `⚠️ No historical candles returned for ${instrumentKey} (${unit}/${intervalValue})`
      );
      return [];
    }

    return candles.map((c) => {
      const timestamp = c[0];

      // For daily/weekly/monthly, use date string; for intraday, use full ISO timestamp
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
    if (err.response?.status) {
      console.error(`   HTTP Status: ${err.response.status}`);
    }
    if (err.response?.data) {
      console.error(
        "   API Error:",
        JSON.stringify(err.response.data, null, 2)
      );
    }
    throw err;
  }
}

// Main: cache BOTH historical + intraday data
async function cacheHistoricalData(instrumentKey, interval) {
  const cacheKey = `history:${instrumentKey}:${interval}`;

  try {
    // Check cache first
    const cached = await redisClient.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      console.log(
        `✅ Using cached history for ${instrumentKey}:${interval} (${parsed.length} candles)`
      );
      return parsed;
    }

    // Access token
    const tokenDoc = await AccessToken.findOne();
    if (!tokenDoc?.token) throw new Error("No access token found in database");

    console.log(`\n📊 Fetching data for ${instrumentKey} [${interval}]`);

    // 1) Historical
    const historicalCandles = await fetchHistoricalCandles(
      instrumentKey,
      interval,
      tokenDoc.token
    );

    // 2) Intraday if NSE open and timeframe is intraday
    let intradayCandles = [];
    const marketOpen = isNSEOpen();
    const { unit } = getUpstoxIntervalParams(interval);
    if (marketOpen && unit === "minutes") {
      console.log(`🔄 Market is OPEN - fetching today's intraday candles...`);
      intradayCandles = await fetchIntradayCandles(
        instrumentKey,
        interval,
        tokenDoc.token
      );
    } else {
      console.log(
        `⏸️ Market CLOSED or higher timeframe - skipping intraday fetch`
      );
    }

    // 3) Merge + sort + de-duplicate
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

    console.log(
      `📦 Total candles: ${allCandles.length} (${historicalCandles.length} hist + ${intradayCandles.length} intraday)`
    );
    if (allCandles.length) {
      console.log(
        `📅 Range: ${allCandles[0].time} → ${
          allCandles[allCandles.length - 1].time
        }\n`
      );
    } else {
      console.warn(
        `⚠️ No candles available for ${instrumentKey} [${interval}]\n`
      );
    }

    // 4) Cache
    const cacheDuration = marketOpen ? 300 : 3600; // seconds
    await redisClient.setEx(
      cacheKey,
      cacheDuration,
      JSON.stringify(allCandles)
    );
    console.log(`💾 Cached with ${cacheDuration}s TTL\n`);

    return allCandles;
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

module.exports = { cacheHistoricalData };
