// controllers/watchlistController.js

const Watchlist = require("../models/Watchlist");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");

exports.getWatchlist = async (req, res) => {
  try {
    const watchlist = await Watchlist.findOne({ user: req.user.id });
    if (!watchlist) return res.json({ symbols: [], prices: {} });

    const symbols = watchlist.symbols; // Array of objects
    const prices = {};

    for (let item of symbols) {
      const symbol = item.instrument_key; // Extract string for ops
      let lastPrice = await redisService.getLastClosePrice(symbol);
      if (!lastPrice) {
        lastPrice = await upstoxService.fetchLastClose(symbol);
      }
      prices[symbol] = lastPrice;
    }

    res.json({ symbols, prices });
  } catch (err) {
    console.error("Error in getWatchlist:", err.message);
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
    console.error("Error in addSymbol:", err);
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
      const userCount = await redisService.getStockUserCount(instrument_key);
      if (userCount === 0) {
        upstoxService.unsubscribe([instrument_key]);
        await redisService.removeStockFromGlobal(instrument_key);
      }
    }
    res.json(watchlist ? watchlist.symbols : []);
  } catch (err) {
    console.error("Error in removeSymbol:", err);
    res.status(500).send("Server error");
  }
};

// New for Plan C: LTP snapshot (if not added before)
exports.getLtpSnapshot = async (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !Array.isArray(symbols))
    return res.status(400).json({ error: "symbols array required" });

  try {
    const prices = {};
    for (let symbol of symbols) {
      let lastPrice = await redisService.getLastClosePrice(symbol);
      if (!lastPrice) lastPrice = await upstoxService.fetchLastClose(symbol);
      prices[symbol] = lastPrice?.close ?? null;
    }
    res.json(prices);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
};
