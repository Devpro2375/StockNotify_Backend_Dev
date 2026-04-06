const axios = require("axios");

const config = require("../config/config");
const AccessToken = require("../models/AccessToken");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");
const { redis: redisClient } = require("./redisService");

const inFlightRequests = new Map();
let cachedAccessToken = null;

const FULL_HISTORY_START = "2000-01-01";
const INTRADAY_HISTORY_START = "2022-01-01";
const FULL_HISTORY_DAYS = 12_000;

function getUpstoxBaseUrl() {
  const baseUrl =
    config.upstoxBaseUrl ||
    config.upstoxRestUrl ||
    process.env.UPSTOX_BASE_URL ||
    "https://api.upstox.com";

  return String(baseUrl).replace(/\/+$/, "");
}

function nowInIST() {
  return new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
  );
}

function isNSEOpen() {
  const now = nowInIST();
  const day = now.getDay();
  if (day === 0 || day === 6) {
    return false;
  }
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return totalMinutes >= 555 && totalMinutes <= 930;
}

async function getAccessToken() {
  if (cachedAccessToken) {
    return cachedAccessToken;
  }

  const tokenDoc = await AccessToken.findOne().lean();
  if (!tokenDoc || !tokenDoc.token) {
    throw new Error("No access token found in database. Please update via admin dashboard.");
  }

  cachedAccessToken = tokenDoc.token;
  return cachedAccessToken;
}

function formatDate(date) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDate(value) {
  const [year, month, day] = String(value).split("-").map(Number);
  return new Date(Date.UTC(year, (month || 1) - 1, day || 1));
}

function addDays(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function addYears(date, years) {
  const next = new Date(date.getTime());
  next.setUTCFullYear(next.getUTCFullYear() + years);
  return next;
}

function maxDate(a, b) {
  return a.getTime() >= b.getTime() ? a : b;
}

function minDate(a, b) {
  return a.getTime() <= b.getTime() ? a : b;
}

function getTodayIstDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return parseDate(`${year}-${month}-${day}`);
}

function getIntervalSpec(interval) {
  const intradayMinutes = new Set(["1", "5", "15", "25", "30", "75", "125"]);

  if (intradayMinutes.has(String(interval))) {
    const minuteInterval = Number(interval);
    return {
      kind: "direct",
      unit: "minutes",
      providerInterval: String(interval),
      historyStart: INTRADAY_HISTORY_START,
      chunkMode: minuteInterval <= 15 ? "month" : "quarter",
      includeIntraday: true,
      dailyLike: false,
    };
  }

  switch (String(interval)) {
    case "day":
      return {
        kind: "direct",
        unit: "days",
        providerInterval: "1",
        historyStart: FULL_HISTORY_START,
        chunkMode: "decade",
        includeIntraday: true,
        dailyLike: true,
      };
    case "week":
      return {
        kind: "direct",
        unit: "weeks",
        providerInterval: "1",
        historyStart: FULL_HISTORY_START,
        chunkMode: "none",
        includeIntraday: false,
        dailyLike: true,
      };
    case "month":
      return {
        kind: "direct",
        unit: "months",
        providerInterval: "1",
        historyStart: FULL_HISTORY_START,
        chunkMode: "none",
        includeIntraday: false,
        dailyLike: true,
      };
    case "quarter":
    case "halfyear":
    case "year":
      return {
        kind: "derived",
        sourceInterval: "month",
        historyStart: FULL_HISTORY_START,
        dailyLike: true,
      };
    default:
      throw new Error(`Unsupported interval: ${interval}`);
  }
}

function buildChunks(startDate, endDate, chunkMode) {
  if (chunkMode === "none") {
    return [{ from: startDate, to: endDate }];
  }

  const chunks = [];
  let cursor = new Date(startDate.getTime());

  while (cursor.getTime() <= endDate.getTime()) {
    let chunkEnd;
    switch (chunkMode) {
      case "month":
        chunkEnd = addDays(addMonths(cursor, 1), -1);
        break;
      case "quarter":
        chunkEnd = addDays(addMonths(cursor, 3), -1);
        break;
      case "decade":
        chunkEnd = addDays(addYears(cursor, 10), -1);
        break;
      default:
        chunkEnd = endDate;
        break;
    }

    chunkEnd = minDate(chunkEnd, endDate);
    chunks.push({ from: cursor, to: chunkEnd });
    cursor = addDays(chunkEnd, 1);
  }

  return chunks;
}

function normalizeCandles(rawCandles, dailyLike) {
  return rawCandles
    .map((candle) => {
      const rawTime = candle?.[0];
      if (rawTime === null || rawTime === undefined) {
        return null;
      }

      const time =
        typeof rawTime === "number"
          ? new Date(rawTime > 1e12 ? rawTime : rawTime * 1000).toISOString()
          : String(rawTime);

      const open = Number(candle?.[1]);
      const high = Number(candle?.[2]);
      const low = Number(candle?.[3]);
      const close = Number(candle?.[4]);
      const volume = Number(candle?.[5] || 0);

      if (![open, high, low, close].every(Number.isFinite)) {
        return null;
      }

      return {
        time: dailyLike ? time.split("T")[0] : time,
        open,
        high,
        low,
        close,
        volume,
      };
    })
    .filter(Boolean);
}

function dedupeCandles(candles) {
  const map = new Map();
  for (const candle of candles) {
    map.set(candle.time, candle);
  }

  return Array.from(map.values()).sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
}

async function requestCandles(url, token) {
  const response = await axios.get(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    timeout: 15_000,
  });

  return response.data?.data?.candles || [];
}

async function fetchHistoricalChunks(instrumentKey, spec, token, startDate, endDate) {
  const encodedKey = encodeURIComponent(instrumentKey);
  const chunks = buildChunks(startDate, endDate, spec.chunkMode);
  const candles = [];
  const upstoxBaseUrl = getUpstoxBaseUrl();

  for (const chunk of chunks) {
    const from = formatDate(chunk.from);
    const to = formatDate(chunk.to);
    const url = `${upstoxBaseUrl}/v3/historical-candle/${encodedKey}/${spec.unit}/${spec.providerInterval}/${to}/${from}`;

    try {
      const rawCandles = await requestCandles(url, token);
      if (rawCandles.length) {
        candles.push(...normalizeCandles(rawCandles, spec.dailyLike));
      }
    } catch (err) {
      const status = err.response?.status;
      const message =
        err.response?.data?.errors?.[0]?.message ||
        err.response?.data?.message ||
        err.message;

      if (status === 401) {
        logger.error("Access token expired in fetchHistoricalChunks");
        throw new Error("Access token expired");
      }

      logger.error(`Error fetching historical candles for ${instrumentKey}`, {
        interval: `${spec.unit}/${spec.providerInterval}`,
        from,
        to,
        status,
        error: message,
      });

      throw new Error(message || "Failed to fetch historical candles");
    }
  }

  return dedupeCandles(candles);
}

async function fetchIntradayOverlay(instrumentKey, spec, token) {
  if (!spec.includeIntraday || !isNSEOpen()) {
    return [];
  }

  try {
    const encodedKey = encodeURIComponent(instrumentKey);
    const upstoxBaseUrl = getUpstoxBaseUrl();
    const url = `${upstoxBaseUrl}/v3/historical-candle/intraday/${encodedKey}/${spec.unit}/${spec.providerInterval}`;
    const rawCandles = await requestCandles(url, token);
    return normalizeCandles(rawCandles, spec.dailyLike);
  } catch (err) {
    logger.warn(`Intraday overlay fetch failed for ${instrumentKey}`, {
      interval: `${spec.unit}/${spec.providerInterval}`,
      status: err.response?.status,
      error:
        err.response?.data?.errors?.[0]?.message ||
        err.response?.data?.message ||
        err.message,
    });
    return [];
  }
}

function alignDerivedStartDate(startDate, interval) {
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth();

  switch (interval) {
    case "quarter":
      return new Date(Date.UTC(year, Math.floor(month / 3) * 3, 1));
    case "halfyear":
      return new Date(Date.UTC(year, month < 6 ? 0 : 6, 1));
    case "year":
      return new Date(Date.UTC(year, 0, 1));
    default:
      return startDate;
  }
}

function aggregateCandles(candles, interval) {
  const groups = new Map();

  for (const candle of candles) {
    const baseDate = parseDate(String(candle.time).split("T")[0]);
    const year = baseDate.getUTCFullYear();
    const month = baseDate.getUTCMonth();

    let key;
    let startMonth;

    switch (interval) {
      case "quarter":
        startMonth = Math.floor(month / 3) * 3;
        key = `${year}-Q${Math.floor(month / 3) + 1}`;
        break;
      case "halfyear":
        startMonth = month < 6 ? 0 : 6;
        key = `${year}-H${month < 6 ? 1 : 2}`;
        break;
      case "year":
        startMonth = 0;
        key = String(year);
        break;
      default:
        return candles;
    }

    const time = formatDate(new Date(Date.UTC(year, startMonth, 1)));
    const existing = groups.get(key);

    if (!existing) {
      groups.set(key, {
        time,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: candle.volume || 0,
      });
      continue;
    }

    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume = (existing.volume || 0) + (candle.volume || 0);
  }

  return Array.from(groups.values()).sort(
    (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime()
  );
}

function resolveRange(interval, requestedDays, fullHistory = false) {
  const spec = getIntervalSpec(interval);
  const today = getTodayIstDate();
  const minimumDate = parseDate(spec.historyStart);

  if (fullHistory || !Number.isFinite(requestedDays) || requestedDays <= 0) {
    return { startDate: minimumDate, endDate: today };
  }

  let startDate = addDays(today, -Math.max(0, requestedDays - 1));
  if (spec.kind === "derived") {
    startDate = alignDerivedStartDate(startDate, interval);
  }

  return {
    startDate: maxDate(startDate, minimumDate),
    endDate: today,
  };
}

async function fetchCandlesForInterval(instrumentKey, interval, token, options = {}) {
  const fullHistory =
    Boolean(options.fullHistory) ||
    !Number.isFinite(options.days) ||
    options.days >= FULL_HISTORY_DAYS;

  const { startDate, endDate } = resolveRange(interval, options.days, fullHistory);
  const spec = getIntervalSpec(interval);

  if (spec.kind === "derived") {
    const sourceSpec = getIntervalSpec(spec.sourceInterval);
    const alignedStartDate = alignDerivedStartDate(startDate, interval);
    const monthlyCandles = await fetchHistoricalChunks(
      instrumentKey,
      sourceSpec,
      token,
      alignedStartDate,
      endDate
    );
    return aggregateCandles(monthlyCandles, interval);
  }

  const [historicalCandles, intradayCandles] = await Promise.all([
    fetchHistoricalChunks(instrumentKey, spec, token, startDate, endDate),
    fetchIntradayOverlay(instrumentKey, spec, token),
  ]);

  return dedupeCandles([...historicalCandles, ...intradayCandles]);
}

function getRangeKey(options = {}) {
  if (options.fullHistory) {
    return "full";
  }

  if (Number.isFinite(options.days) && options.days > 0) {
    return `d${options.days}`;
  }

  return "default";
}

function refreshCacheInBackground(instrumentKey, interval, options, cacheKey, inFlightKey) {
  if (inFlightRequests.has(inFlightKey)) {
    return;
  }

  const request = fetchAndCache(instrumentKey, interval, options, cacheKey).finally(() => {
    inFlightRequests.delete(inFlightKey);
  });

  inFlightRequests.set(inFlightKey, request);
  request.catch((err) => {
    logger.warn(`Background cache refresh failed for ${instrumentKey}:${interval}`, {
      rangeKey: getRangeKey(options),
      error: err.message,
    });
  });
}

async function fetchAndCache(instrumentKey, interval, options, cacheKey) {
  const token = await getAccessToken();
  const candles = await fetchCandlesForInterval(instrumentKey, interval, token, options);

  const cacheDuration = isNSEOpen() ? 120 : 3600;
  try {
    await redisClient.setex(cacheKey, cacheDuration, JSON.stringify(candles));
  } catch (err) {
    if (!String(err.message).includes("MISCONF")) {
      logger.warn(`Redis write error for ${cacheKey}`, { error: err.message });
    }
  }

  return candles;
}

async function cacheHistoricalData(instrumentKey, interval, options = {}) {
  const normalizedOptions = {
    days:
      Number.isFinite(Number(options.days)) && Number(options.days) > 0
        ? Number(options.days)
        : undefined,
    fullHistory: Boolean(options.fullHistory),
  };
  const rangeKey = getRangeKey(normalizedOptions);
  const cacheKey = `history:${instrumentKey}:${interval}:${rangeKey}`;
  const inFlightKey = `${instrumentKey}:${interval}:${rangeKey}`;

  try {
    let cached = null;
    try {
      cached = await redisClient.get(cacheKey);
    } catch (err) {
      if (!String(err.message).includes("MISCONF")) {
        logger.warn(`Redis read error for ${cacheKey}`, { error: err.message });
      }
    }

    if (cached) {
      metrics.inc("history_cache_hits");
      try {
        const ttl = await redisClient.ttl(cacheKey);
        const maxTtl = isNSEOpen() ? 120 : 3600;
        if (ttl > 0 && ttl < maxTtl / 2) {
          refreshCacheInBackground(
            instrumentKey,
            interval,
            normalizedOptions,
            cacheKey,
            inFlightKey
          );
        }
      } catch {}
      return JSON.parse(cached);
    }

    metrics.inc("history_cache_misses");

    if (inFlightRequests.has(inFlightKey)) {
      return await inFlightRequests.get(inFlightKey);
    }

    const request = fetchAndCache(
      instrumentKey,
      interval,
      normalizedOptions,
      cacheKey
    ).finally(() => {
      inFlightRequests.delete(inFlightKey);
    });

    inFlightRequests.set(inFlightKey, request);
    return await request;
  } catch (err) {
    logger.error(`Error in cacheHistoricalData for ${instrumentKey}`, {
      interval,
      rangeKey,
      error: err.message,
    });

    if (err.response?.status === 401) {
      throw new Error("Access token expired");
    }
    if (err.response?.status === 404) {
      throw new Error("Instrument not found");
    }
    throw err;
  }
}

function invalidateTokenCache() {
  cachedAccessToken = null;
}

module.exports = { cacheHistoricalData, invalidateTokenCache };
