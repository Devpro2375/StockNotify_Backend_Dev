"use strict";

const { resolveQuotes } = require("../services/priceResolver");
const logger = require("../utils/logger");

/**
 * GET /api/market-data/quotes
 * Uses shared price resolver for tick/cache/provider fallback.
 */
exports.getQuotes = async (req, res) => {
  try {
    const { instruments } = req.query;
    if (!instruments) {
      return res.status(400).json({ error: "Instruments parameter required" });
    }

    const instrumentList = instruments
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!instrumentList.length) {
      return res.status(400).json({ error: "No instruments provided" });
    }

    const quotes = await resolveQuotes(instrumentList);
    return res.json(quotes);
  } catch (error) {
    logger.error("Market data API error", { error: error.message });
    return res.status(500).json({ error: "Internal server error" });
  }
};
