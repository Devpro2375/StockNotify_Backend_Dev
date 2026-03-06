// controllers/marketDataController.js
"use strict";

const axios = require("axios");
const redisService = require("../services/redisService");
const AccessToken = require("../models/AccessToken");
const config = require("../config/config");
const upstoxService = require("../services/upstoxService");
const logger = require("../utils/logger");

function buildFallbackOhlc(price, closePrice = price) {
  return {
    open: closePrice,
    high: price,
    low: price,
    close: price,
  };
}

function parseV3LtpQuote(response, instrument) {
  const data = response?.data?.data?.[instrument];
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
  const data = response?.data?.data?.[instrument];
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

    // Batch fetch ticks + close prices in two Redis round-trips
    const [ticks, closePrices] = await Promise.all([
      redisService.getLastTickBatch(instrumentList),
      redisService.getLastClosePriceBatch(instrumentList),
    ]);

    // Lazy-load token only if needed for API fallback
    let accessToken = null;

    const quotes = {};
    for (const instrument of instrumentList) {
      // 1) Real-time tick
      const lastTick = ticks[instrument];
      if (lastTick) {
        const ltp =
          lastTick?.fullFeed?.marketFF?.ltpc?.ltp ??
          lastTick?.fullFeed?.indexFF?.ltpc?.ltp ??
          null;

        if (ltp != null) {
          quotes[instrument] = {
            last_price: ltp,
            ohlc: {
              open: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.open ?? ltp,
              high: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.high ?? ltp,
              low: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.low ?? ltp,
              close: ltp,
            },
            source: "realtime",
          };
          continue;
        }
      }

      // 2) Close price cache
      const lastClose = closePrices[instrument];
      if (lastClose) {
        quotes[instrument] = {
          last_price: lastClose.close,
          ohlc: {
            open: lastClose.open,
            high: lastClose.high,
            low: lastClose.low,
            close: lastClose.close,
          },
          source: "historical",
        };
        continue;
      }

      // 3) API fallback (lazy token load)
      try {
        if (!accessToken) {
          const tokenDoc = await AccessToken.findOne().lean();
          accessToken = tokenDoc?.token || null;
        }
        if (!accessToken) {
          quotes[instrument] = null;
          continue;
        }

        const baseUrl = config.upstoxRestUrl || "https://api.upstox.com";
        const quoteAttempts = [
          {
            label: "v3_ltp",
            url: `${baseUrl}/v3/market-quote/ltp?instrument_key=${encodeURIComponent(instrument)}`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
            },
            parse: parseV3LtpQuote,
          },
          {
            label: "v2_full_quote",
            url: `${baseUrl}/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument)}`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              Accept: "application/json",
              "Api-Version": "2.0",
            },
            parse: parseV2FullQuote,
          },
        ];

        let resolvedQuote = null;

        for (const attempt of quoteAttempts) {
          try {
            const response = await axios.get(attempt.url, {
              headers: attempt.headers,
              timeout: 5000,
            });
            resolvedQuote = attempt.parse(response, instrument);
            if (resolvedQuote) {
              break;
            }
          } catch (attemptError) {
            logger.warn(`Quote fallback ${attempt.label} failed for ${instrument}`, {
              status: attemptError.response?.status,
              error: attemptError.message,
            });
          }
        }

        if (!resolvedQuote) {
          const lastClose = await upstoxService.fetchLastClose(instrument);
          if (lastClose?.close != null) {
            resolvedQuote = {
              last_price: Number(lastClose.close),
              ohlc: {
                open: Number(lastClose.open ?? lastClose.close),
                high: Number(lastClose.high ?? lastClose.close),
                low: Number(lastClose.low ?? lastClose.close),
                close: Number(lastClose.close),
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
