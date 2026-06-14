"use strict";

const axios = require("axios");

const AccessToken = require("../models/AccessToken");
const config = require("../config/config");
const logger = require("../utils/logger");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");

const DEFAULT_QUOTE_TICK_MAX_AGE_MS = Number(process.env.QUOTE_TICK_MAX_AGE_MS || 60_000);

function normalizeInstrumentKeys(instruments) {
  const list = Array.isArray(instruments) ? instruments : [instruments];
  return [...new Set(list.map((key) => String(key || "").trim()).filter(Boolean))];
}

function extractTickLtp(tick) {
  return (
    tick?.fullFeed?.marketFF?.ltpc?.ltp ??
    tick?.fullFeed?.indexFF?.ltpc?.ltp ??
    tick?.ltpc?.ltp ??
    tick?.firstLevelWithGreeks?.ltpc?.ltp ??
    null
  );
}

function buildFallbackOhlc(price, closePrice = price) {
  return {
    open: closePrice,
    high: price,
    low: price,
    close: price,
  };
}

function extractTickOhlc(tick, ltp) {
  const ohlcList =
    tick?.fullFeed?.marketFF?.marketOHLC?.ohlc ??
    tick?.fullFeed?.indexFF?.marketOHLC?.ohlc ??
    [];
  const dayCandle = Array.isArray(ohlcList)
    ? ohlcList.find((candle) => candle?.interval === "1d") || ohlcList[0]
    : null;

  return {
    open: Number(dayCandle?.open ?? ltp),
    high: Number(dayCandle?.high ?? ltp),
    low: Number(dayCandle?.low ?? ltp),
    close: Number(ltp),
  };
}

function getTickReceivedAt(tick) {
  const receivedAt = Number(tick?.__receivedAt ?? tick?.receivedAt);
  return Number.isFinite(receivedAt) && receivedAt > 0 ? receivedAt : null;
}

function isFreshTick(tick, maxAgeMs = DEFAULT_QUOTE_TICK_MAX_AGE_MS) {
  const receivedAt = getTickReceivedAt(tick);
  return Boolean(receivedAt && Date.now() - receivedAt <= maxAgeMs);
}

async function getCachedTicksAndCloses(instrumentKeys, options = {}) {
  const keys = normalizeInstrumentKeys(instrumentKeys);
  if (!keys.length) {
    return { ticks: {}, closePrices: {} };
  }

  try {
    const [ticks, closePrices] = await Promise.all([
      redisService.getLastTickBatch(keys),
      redisService.getLastClosePriceBatch(keys),
    ]);
    return { ticks, closePrices };
  } catch (error) {
    if (!options.swallowRedisErrors) {
      throw error;
    }

    logger.warn("Redis price cache unavailable, using provider fallbacks", {
      context: options.context || "priceResolver",
      error: error.message,
    });
    return { ticks: {}, closePrices: {} };
  }
}

async function fetchMissingClosePrices(missingKeys, closePrices) {
  if (!missingKeys.length) return;

  const fetched = await Promise.allSettled(
    missingKeys.map((key) => upstoxService.fetchLastClose(key))
  );

  for (let i = 0; i < missingKeys.length; i++) {
    if (fetched[i].status === "fulfilled" && fetched[i].value) {
      closePrices[missingKeys[i]] = fetched[i].value;
    }
  }
}

async function resolveClosePrices(instrumentKeys) {
  const keys = normalizeInstrumentKeys(instrumentKeys);
  if (!keys.length) return {};

  const { ticks, closePrices } = await getCachedTicksAndCloses(keys);

  for (const key of keys) {
    const tickLtp = extractTickLtp(ticks[key]);
    const tickPrice = Number(tickLtp);
    if (tickLtp != null && Number.isFinite(tickPrice)) {
      closePrices[key] = {
        ...(closePrices[key] || {}),
        close: tickPrice,
        source: "realtime",
      };
    }
  }

  const missing = keys.filter((key) => {
    const tickLtp = extractTickLtp(ticks[key]);
    const tickPrice = Number(tickLtp);
    return (tickLtp == null || !Number.isFinite(tickPrice)) && !closePrices[key];
  });
  await fetchMissingClosePrices(missing, closePrices);

  return closePrices;
}

function parseV2FullQuote(response, instrument) {
  const responseData = response?.data?.data || {};
  const data =
    responseData[instrument] ||
    Object.values(responseData).find((quote) => {
      const token = quote?.instrument_token || quote?.instrumentToken;
      return token === instrument;
    });
  if (data?.last_price == null) {
    return null;
  }

  const price = Number(data.last_price);
  if (!Number.isFinite(price)) {
    return null;
  }

  return {
    last_price: price,
    ohlc: data.ohlc || buildFallbackOhlc(price),
    source: "upstox_quote_v2",
  };
}

function closePriceToQuote(closePrice, source) {
  if (closePrice?.close == null) return null;
  const close = Number(closePrice.close);
  if (!Number.isFinite(close)) return null;

  return {
    last_price: close,
    ohlc: {
      open: Number(closePrice.open ?? close),
      high: Number(closePrice.high ?? close),
      low: Number(closePrice.low ?? close),
      close,
    },
    source,
  };
}

async function fetchV2FullQuote(instrument, token) {
  const baseUrl = config.upstoxRestUrl || "https://api.upstox.com";
  const response = await axios.get(
    `${baseUrl}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Api-Version": "2.0",
      },
      timeout: 5000,
    }
  );

  return parseV2FullQuote(response, instrument);
}

async function resolveQuotes(instrumentKeys, options = {}) {
  const keys = normalizeInstrumentKeys(instrumentKeys);
  if (!keys.length) return {};

  const { ticks, closePrices } = await getCachedTicksAndCloses(keys, {
    swallowRedisErrors: true,
    context: "resolveQuotes",
  });

  const quotes = {};
  const needsApiQuote = [];
  const tickMaxAgeMs = Number(options.tickMaxAgeMs || DEFAULT_QUOTE_TICK_MAX_AGE_MS);

  for (const instrument of keys) {
    const lastTick = ticks[instrument];
    const ltp = extractTickLtp(lastTick);
    const price = Number(ltp);

    if (ltp != null && Number.isFinite(price) && isFreshTick(lastTick, tickMaxAgeMs)) {
      quotes[instrument] = {
        last_price: price,
        ohlc: extractTickOhlc(lastTick, price),
        source: "realtime",
      };
      continue;
    }

    needsApiQuote.push(instrument);
  }

  let apiQuotes = {};
  if (needsApiQuote.length) {
    try {
      apiQuotes = await upstoxService.fetchLtpQuotes(needsApiQuote);
    } catch (error) {
      logger.warn("Batch LTP quote fallback failed", {
        status: error.response?.status,
        error: error.message,
      });
    }
  }

  let accessToken = null;
  let accessTokenLoaded = false;

  for (const instrument of keys) {
    if (quotes[instrument]) continue;

    const apiQuote = apiQuotes[instrument];
    if (apiQuote) {
      quotes[instrument] = apiQuote;
      continue;
    }

    let resolvedQuote = null;

    try {
      if (options.allowV2Fallback !== false) {
        if (!accessTokenLoaded) {
          const tokenDoc = await AccessToken.findOne().lean();
          accessToken = tokenDoc?.token || null;
          accessTokenLoaded = true;
        }

        if (accessToken) {
          try {
            resolvedQuote = await fetchV2FullQuote(instrument, accessToken);
          } catch (attemptError) {
            logger.warn(`Quote fallback v2_full_quote failed for ${instrument}`, {
              status: attemptError.response?.status,
              error: attemptError.message,
            });
          }
        }
      }

      if (!resolvedQuote) {
        resolvedQuote = closePriceToQuote(closePrices[instrument], "historical");
      }

      if (!resolvedQuote) {
        const fetchedClose = await upstoxService.fetchLastClose(instrument);
        resolvedQuote = closePriceToQuote(fetchedClose, "historical_fallback");
      }

      quotes[instrument] = resolvedQuote;
    } catch (error) {
      logger.warn(`Failed to fetch quote for ${instrument}`, {
        status: error.response?.status,
        error: error.message,
      });
      quotes[instrument] = null;
    }
  }

  return quotes;
}

module.exports = {
  extractTickLtp,
  extractTickOhlc,
  isFreshTick,
  resolveClosePrices,
  resolveQuotes,
};
