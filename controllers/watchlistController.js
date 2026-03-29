// controllers/watchlistController.js
"use strict";

const Watchlist = require("../models/Watchlist");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const logger = require("../utils/logger");

// ── Helper: get or create default watchlist ──
async function getDefaultWatchlist(userId) {
  let wl = await Watchlist.findOne({ user: userId, type: "default" });
  if (!wl) {
    wl = new Watchlist({ user: userId, name: "My Stocks", type: "default", order: 0, symbols: [] });
    await wl.save();
  }
  return wl;
}

// ── Helper: batch fetch close prices ──
async function fetchClosePrices(instrumentKeys) {
  const closePrices = await redisService.getLastClosePriceBatch(instrumentKeys);
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
  return closePrices;
}

// ════════════════════════════════════════════════════════════════════════════
// GET /api/watchlist — returns ALL watchlists for user
// ════════════════════════════════════════════════════════════════════════════
exports.getAllWatchlists = async (req, res) => {
  try {
    let watchlists = await Watchlist.find({ user: req.user.id }).sort({ order: 1 }).lean();

    // Auto-create default if none exists
    if (!watchlists.length || !watchlists.find((w) => w.type === "default")) {
      const def = await getDefaultWatchlist(req.user.id);
      watchlists = [def, ...watchlists.filter((w) => w.type !== "default")];
    }

    res.json({ watchlists });
  } catch (err) {
    logger.error("Error in getAllWatchlists", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/watchlist/:id — single watchlist with prices
// ════════════════════════════════════════════════════════════════════════════
exports.getWatchlist = async (req, res) => {
  try {
    const wl = await Watchlist.findOne({ _id: req.params.id, user: req.user.id }).lean();
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });

    const instrumentKeys = wl.symbols.map((s) => s.instrument_key);
    const closePrices = await fetchClosePrices(instrumentKeys);

    res.json({ symbols: wl.symbols, prices: closePrices });
  } catch (err) {
    logger.error("Error in getWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// GET /api/watchlist/default — backward compat: returns default watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.getDefaultWatchlist = async (req, res) => {
  try {
    const wl = await getDefaultWatchlist(req.user.id);
    const instrumentKeys = wl.symbols.map((s) => s.instrument_key);
    const closePrices = await fetchClosePrices(instrumentKeys);
    res.json({ symbols: wl.symbols, prices: closePrices });
  } catch (err) {
    logger.error("Error in getDefaultWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// POST /api/watchlist — create new custom watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.createWatchlist = async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });

  try {
    const count = await Watchlist.countDocuments({ user: req.user.id });
    if (count >= 20) return res.status(400).json({ error: "Max 20 watchlists" });

    const wl = new Watchlist({
      user: req.user.id,
      name: name.trim(),
      type: "custom",
      order: count,
      symbols: [],
    });
    await wl.save();
    res.json(wl);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "Name already exists" });
    logger.error("Error in createWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// PUT /api/watchlist/:id — rename watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.renameWatchlist = async (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: "Name required" });

  try {
    const wl = await Watchlist.findOne({ _id: req.params.id, user: req.user.id });
    if (!wl) return res.status(404).json({ error: "Not found" });

    wl.name = name.trim();
    await wl.save();
    res.json(wl);
  } catch (err) {
    if (err.code === 11000) return res.status(400).json({ error: "Name already exists" });
    logger.error("Error in renameWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// DELETE /api/watchlist/:id — delete custom watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.deleteWatchlist = async (req, res) => {
  try {
    const wl = await Watchlist.findOne({ _id: req.params.id, user: req.user.id });
    if (!wl) return res.status(404).json({ error: "Not found" });
    if (wl.type === "default") return res.status(400).json({ error: "Cannot delete default watchlist" });

    // Unsubscribe symbols (parallel — avoids N+1 sequential Redis round-trips)
    await Promise.allSettled(
      wl.symbols.map(async (s) => {
        await redisService.removeUserFromStock(req.user.id, s.instrument_key);
        const shouldKeep = await redisService.shouldSubscribe(s.instrument_key);
        if (!shouldKeep) {
          upstoxService.unsubscribe([s.instrument_key]);
          await redisService.removeStockFromGlobal(s.instrument_key);
        }
      })
    );

    await Watchlist.deleteOne({ _id: wl._id });
    res.json({ success: true });
  } catch (err) {
    logger.error("Error in deleteWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// POST /api/watchlist/:id/add — add symbol to specific watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.addSymbolToWatchlist = async (req, res) => {
  const { instrument_key, name: trading_symbol } = req.body;
  if (!instrument_key || !trading_symbol)
    return res.status(400).json({ message: "instrument_key and trading_symbol required" });

  try {
    const wl = await Watchlist.findOne({ _id: req.params.id, user: req.user.id });
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });

    if (!wl.symbols.some((s) => s.instrument_key === instrument_key)) {
      wl.symbols.push({ instrument_key, trading_symbol });
      await wl.save();

      await redisService.addUserToStock(req.user.id, instrument_key);
      const userCount = await redisService.getStockUserCount(instrument_key);
      if (userCount === 1) upstoxService.subscribe([instrument_key]);
    }

    res.json(wl.symbols);
  } catch (err) {
    logger.error("Error in addSymbolToWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// POST /api/watchlist/:id/remove — remove symbol from specific watchlist
// ════════════════════════════════════════════════════════════════════════════
exports.removeSymbolFromWatchlist = async (req, res) => {
  const { instrument_key } = req.body;
  if (!instrument_key) return res.status(400).json({ message: "instrument_key required" });

  try {
    const wl = await Watchlist.findOne({ _id: req.params.id, user: req.user.id });
    if (!wl) return res.status(404).json({ error: "Watchlist not found" });

    wl.symbols = wl.symbols.filter((s) => s.instrument_key !== instrument_key);
    await wl.save();

    await redisService.removeUserFromStock(req.user.id, instrument_key);
    if (!(await redisService.shouldSubscribe(instrument_key))) {
      upstoxService.unsubscribe([instrument_key]);
      await redisService.removeStockFromGlobal(instrument_key);
    }

    res.json(wl.symbols);
  } catch (err) {
    logger.error("Error in removeSymbolFromWatchlist", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// Backward compat: old add/remove (operates on default watchlist)
// ════════════════════════════════════════════════════════════════════════════
exports.addSymbol = async (req, res) => {
  const { instrument_key, name: trading_symbol } = req.body;
  if (!instrument_key || !trading_symbol)
    return res.status(400).json({ message: "instrument_key and trading_symbol required" });

  try {
    const wl = await getDefaultWatchlist(req.user.id);

    if (!wl.symbols.some((s) => s.instrument_key === instrument_key)) {
      wl.symbols.push({ instrument_key, trading_symbol });
      await wl.save();
      await redisService.addUserToStock(req.user.id, instrument_key);
      const userCount = await redisService.getStockUserCount(instrument_key);
      if (userCount === 1) upstoxService.subscribe([instrument_key]);
    }

    res.json(wl.symbols);
  } catch (err) {
    logger.error("Error in addSymbol", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

exports.removeSymbol = async (req, res) => {
  const { instrument_key } = req.body;
  if (!instrument_key) return res.status(400).json({ message: "instrument_key required" });

  try {
    const wl = await getDefaultWatchlist(req.user.id);
    wl.symbols = wl.symbols.filter((s) => s.instrument_key !== instrument_key);
    await wl.save();

    await redisService.removeUserFromStock(req.user.id, instrument_key);
    if (!(await redisService.shouldSubscribe(instrument_key))) {
      upstoxService.unsubscribe([instrument_key]);
      await redisService.removeStockFromGlobal(instrument_key);
    }

    res.json(wl.symbols);
  } catch (err) {
    logger.error("Error in removeSymbol", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

// ════════════════════════════════════════════════════════════════════════════
// POST /api/watchlist/ltp-snapshot (unchanged)
// ════════════════════════════════════════════════════════════════════════════
exports.getLtpSnapshot = async (req, res) => {
  const { symbols } = req.body;
  if (!symbols || !Array.isArray(symbols))
    return res.status(400).json({ error: "symbols array required" });

  try {
    const closePrices = await fetchClosePrices(symbols);
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
