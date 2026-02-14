// controllers/marketDataController.js
"use strict";

const axios = require("axios");
const redisService = require("../services/redisService");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");

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

    const results = await Promise.all(
      instrumentList.map(async (instrument) => {
        try {
          // 1) Attempt last tick (real-time)
          const lastTick = await redisService.getLastTick(instrument);
          const ltp =
            lastTick?.fullFeed?.marketFF?.ltpc?.ltp ??
            lastTick?.fullFeed?.indexFF?.ltpc?.ltp ??
            null;

          if (ltp != null) {
            return {
              [instrument]: {
                last_price: ltp,
                ohlc: {
                  open:
                    lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.open ?? ltp,
                  high:
                    lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.high ?? ltp,
                  low:
                    lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.low ?? ltp,
                  close: ltp,
                },
                source: "realtime",
              },
            };
          }

          // 2) Fallback: last close cache
          const lastClose = await redisService.getLastClosePrice(instrument);
          if (lastClose) {
            return {
              [instrument]: {
                last_price: lastClose.close,
                ohlc: {
                  open: lastClose.open,
                  high: lastClose.high,
                  low: lastClose.low,
                  close: lastClose.close,
                },
                source: "historical",
              },
            };
          }

          // 3) Final fallback: Upstox API v2 quotes (use dynamic token from DB)
          const tokenDoc = await AccessToken.findOne().lean();
          if (!tokenDoc?.token) {
            console.warn(`No access token available for API fallback`);
            return { [instrument]: null };
          }
          const url = `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(
            instrument
          )}`;
          const response = await axios.get(url, {
            headers: {
              Authorization: `Bearer ${tokenDoc.token}`,
              Accept: "application/json",
            },
            timeout: 5000,
          });

          if (response.data?.data?.[instrument]) {
            const data = response.data.data[instrument];
            return {
              [instrument]: {
                last_price: data.last_price,
                ohlc: data.ohlc,
                source: "upstox_api",
              },
            };
          }

          return { [instrument]: null };
        } catch (error) {
          console.error(
            `Failed to fetch quote for ${instrument}:`,
            error.message
          );
          return { [instrument]: null };
        }
      })
    );

    const quotes = results.reduce((acc, curr) => Object.assign(acc, curr), {});
    res.json(quotes);
  } catch (error) {
    console.error("Market data API error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};
