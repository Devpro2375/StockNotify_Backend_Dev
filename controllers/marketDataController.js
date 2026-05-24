// controllers/marketDataController.js
"use strict";

const axios = require("axios");
const redisService = require("../services/redisService");
const AccessToken = require("../models/AccessToken");
const config = require("../config/config");
const upstoxService = require("../services/upstoxService");
const logger = require("../utils/logger");

const QUOTE_TICK_MAX_AGE_MS = Number(process.env.QUOTE_TICK_MAX_AGE_MS || 60_000);

function buildFallbackOhlc(price, closePrice = price) {
  return {
    open: closePrice,
    high: price,
    low: price,
    close: price,
  };
}

function parseV3LtpQuote(response, instrument) {
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
  const closePrice = Number(data.cp ?? data.last_price);

  return {
    last_price: price,
    ohlc: buildFallbackOhlc(price, closePrice),
    source: "upstox_ltp_v3",
  };
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

  return {
    last_price: price,
    ohlc: data.ohlc || buildFallbackOhlc(price),
    source: "upstox_quote_v2",
  };
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

function extractTickOhlc(tick, ltp) {
  const ohlcList =
    tick?.fullFeed?.marketFF?.marketOHLC?.ohlc ??
    tick?.fullFeed?.indexFF?.marketOHLC?.ohlc ??
    [];
  const dayCandle = Array.isArray(ohlcList)
    ? ohlcList.find((c) => c?.interval === "1d") || ohlcList[0]
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

function isFreshTick(tick) {
  const receivedAt = getTickReceivedAt(tick);
  return Boolean(receivedAt && Date.now() - receivedAt <= QUOTE_TICK_MAX_AGE_MS);
}

/**
 * GET /api/market-data/quotes
 * REFACTORED: Batch tick + close lookups, single token fetch for API fallback.
 */
exports.getQuotes = async (req, res) => {
  try {
    const { instruments } = req.query;
    if (!instruments)
      return res.status(400).json({ error: "Instruments parameter required" });

    const instrumentList = instruments
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!instrumentList.length)
      return res.status(400).json({ error: "No instruments provided" });

    let ticks = {};
    let closePrices = {};

    // Redis should help, but quote lookup must still work without it.
    try {
      [ticks, closePrices] = await Promise.all([
        redisService.getLastTickBatch(instrumentList),
        redisService.getLastClosePriceBatch(instrumentList),
      ]);
    } catch (redisError) {
      logger.warn("Redis quote cache unavailable, using API fallbacks", {
        error: redisError.message,
      });
    }

    const quotes = {};
    const needsApiQuote = [];

    for (const instrument of instrumentList) {
      const lastTick = ticks[instrument];
      const ltp = extractTickLtp(lastTick);

      if (ltp != null && isFreshTick(lastTick)) {
        quotes[instrument] = {
          last_price: Number(ltp),
          ohlc: extractTickOhlc(lastTick, ltp),
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

    // Lazy-load token only if needed for the older v2 fallback path.
    let accessToken = null;

    for (const instrument of instrumentList) {
      if (quotes[instrument]) continue;

      const apiQuote = apiQuotes[instrument];
      if (apiQuote) {
        quotes[instrument] = apiQuote;
        continue;
      }

      let resolvedQuote = null;

      try {
        if (!accessToken) {
          const tokenDoc = await AccessToken.findOne().lean();
          accessToken = tokenDoc?.token || null;
        }

        if (accessToken) {
          const baseUrl = config.upstoxRestUrl || "https://api.upstox.com";
          try {
            const response = await axios.get(
              `${baseUrl}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument)}`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                  Accept: "application/json",
                  "Api-Version": "2.0",
                },
                timeout: 5000,
              }
            );
            resolvedQuote = parseV2FullQuote(response, instrument);
          } catch (attemptError) {
            logger.warn(`Quote fallback v2_full_quote failed for ${instrument}`, {
              status: attemptError.response?.status,
              error: attemptError.message,
            });
          }
        }

        const lastClose = closePrices[instrument];
        if (!resolvedQuote && lastClose) {
          resolvedQuote = {
            last_price: lastClose.close,
            ohlc: {
              open: lastClose.open,
              high: lastClose.high,
              low: lastClose.low,
              close: lastClose.close,
            },
            source: "historical",
          };
        }

        if (!resolvedQuote) {
          const fetchedClose = await upstoxService.fetchLastClose(instrument);
          if (fetchedClose?.close != null) {
            resolvedQuote = {
              last_price: Number(fetchedClose.close),
              ohlc: {
                open: Number(fetchedClose.open ?? fetchedClose.close),
                high: Number(fetchedClose.high ?? fetchedClose.close),
                low: Number(fetchedClose.low ?? fetchedClose.close),
                close: Number(fetchedClose.close),
              },
              source: "historical_fallback",
            };
          }
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

    res.json(quotes);
  } catch (error) {
    logger.error("Market data API error", { error: error.message });
    res.status(500).json({ error: "Internal server error" });
  }
};
