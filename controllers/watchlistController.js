// controllers/watchlistController.js
"use strict";

const Watchlist = require("../models/Watchlist");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const logger = require("../utils/logger");

/**
 * GET /api/watchlist
 * REFACTORED: Uses batch Redis lookup instead of N sequential calls.
 */
exports.getWatchlist = async (req, res) => {
  try {
    const watchlist = await Watchlist.findOne({ user: req.user.id });
    if (!watchlist) return res.json({ symbols: [], prices: {} });

    const symbols = watchlist.symbols;
    const instrumentKeys = symbols.map((s) => s.instrument_key);

    // Batch fetch in one Redis round-trip
    const closePrices = await redisService.getLastClosePriceBatch(instrumentKeys);

    // Fetch missing from API in parallel
    const missing = instrumentKeys.filter((k) => !closePrices[k]);
    if (missing.length) {
      const fetched = await Promise.allSettled(
        missing.map((k) => upstoxService.fetchLastClose(k))
      );
      for (let i = 0; i < missing.length; i++) {
        if (fetched[i].status === "fulfilled" && fetched[i].value) {
          closePrices[missing[i]] = fetched[i].value;
        }
      }
    }

    res.json({ symbols, prices: closePrices });
  } catch (err) {
    logger.error("Error in getWatchlist", { error: err.message });
    res.status(500).send("Server error");
  }
};

exports.addSymbol = async (req, res) => {
  const { instrument_key, name: trading_symbol } = req.body;
  if (!instrument_key || !trading_symbol)
    return res.status(400).send("instrument_key and trading_symbol required");

  try {
    let watchlist = await Watchlist.findOne({ user: req.user.id });
    if (!watchlist)
      watchlist = new Watchlist({ user: req.user.id, symbols: [] });

    if (!watchlist.symbols.some((s) => s.instrument_key === instrument_key)) {
      watchlist.symbols.push({ instrument_key, trading_symbol });
      await watchlist.save();

      await redisService.addUserToStock(req.user.id, instrument_key);
      const userCount = await redisService.getStockUserCount(instrument_key);
      if (userCount === 1) upstoxService.subscribe([instrument_key]);
    }

    res.json(watchlist.symbols);
  } catch (err) {
    logger.error("Error in addSymbol", { error: err.message });
    res.status(500).send("Server error");
  }
};

exports.removeSymbol = async (req, res) => {
  const { instrument_key } = req.body;
  if (!instrument_key) return res.status(400).send("instrument_key required");

  try {
    const watchlist = await Watchlist.findOne({ user: req.user.id });
    if (watchlist) {
      watchlist.symbols = watchlist.symbols.filter(
        (s) => s.instrument_key !== instrument_key
      );
      await watchlist.save();

      await redisService.removeUserFromStock(req.user.id, instrument_key);
      if (!(await redisService.shouldSubscribe(instrument_key))) {
        upstoxService.unsubscribe([instrument_key]);
        await redisService.removeStockFromGlobal(instrument_key);
      }
    }
    res.json(watchlist ? watchlist.symbols : []);
  } catch (err) {
    logger.error("Error in removeSymbol", { error: err.message });
    res.status(500).send("Server error");
  }
};

/**
 * POST /api/watchlist/ltp-snapshot
 * REFACTORED: Batch Redis lookup.
 */
exports.getLtpSnapshot = async (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !Array.isArray(symbols))
    return res.status(400).json({ error: "symbols array required" });

  try {
    const closePrices = await redisService.getLastClosePriceBatch(symbols);

    // Fetch missing
    const missing = symbols.filter((s) => !closePrices[s]);
    if (missing.length) {
      const fetched = await Promise.allSettled(
        missing.map((k) => upstoxService.fetchLastClose(k))
      );
      for (let i = 0; i < missing.length; i++) {
        if (fetched[i].status === "fulfilled" && fetched[i].value) {
          closePrices[missing[i]] = fetched[i].value;
        }
      }
    }

    const prices = {};
    for (const symbol of symbols) {
      prices[symbol] = closePrices[symbol]?.close ?? null;
    }
    res.json(prices);
  } catch (err) {
    logger.error("getLtpSnapshot error", { error: err.message });
    res.status(500).json({ error: "Server error" });
  }
};
