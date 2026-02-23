// controllers/marketDataController.js
"use strict";

const axios = require("axios");
const redisService = require("../services/redisService");
const AccessToken = require("../models/AccessToken");
const logger = require("../utils/logger");

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

        const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument)}`;
        const response = await axios.get(url, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            Accept: "application/json",
          },
          timeout: 5000,
        });

        if (response.data?.data?.[instrument]) {
          const data = response.data.data[instrument];
          quotes[instrument] = {
            last_price: data.last_price,
            ohlc: data.ohlc,
            source: "upstox_api",
          };
        } else {
          quotes[instrument] = null;
        }
      } catch (error) {
        logger.warn(`Failed to fetch quote for ${instrument}`, {
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
