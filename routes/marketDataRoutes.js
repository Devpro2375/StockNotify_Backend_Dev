// routes/marketDataRoutes.js
"use strict";

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const marketDataController = require("../controllers/marketDataController");
const historyService = require("../services/historyService");

const validIntervals = new Set([
  "1minute",
  "5minute",
  "15minute",
  "25minute",
  "30minute",
  "75minute",
  "125minute",
  "1",
  "5",
  "15",
  "25",
  "30",
  "75",
  "125",
  "day",
  "week",
  "month",
  "quarter",
  "halfyear",
  "year",
]);

const legacyIntervalMap = {
  "1minute": "1",
  "5minute": "5",
  "15minute": "15",
  "25minute": "25",
  "30minute": "30",
  "75minute": "75",
  "125minute": "125",
};

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

router.get("/quotes", authMiddleware, marketDataController.getQuotes);

router.get("/historical/:instrumentKey", authMiddleware, async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const rawInterval = String(req.query.interval || "day");
    const rawDays = req.query.days;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const includeIntraday = parseBooleanFlag(req.query.includeIntraday, true);
    const fullHistory =
      String(req.query.fullHistory || "").toLowerCase() === "true" ||
      String(req.query.fullHistory || "") === "1" ||
      String(rawDays || "").toLowerCase() === "all";
    const days = rawDays === undefined || fullHistory ? undefined : Number(rawDays);
    const interval = legacyIntervalMap[rawInterval] || rawInterval;

    if (!validIntervals.has(rawInterval) && !validIntervals.has(interval)) {
      return res.status(400).json({ msg: "Invalid interval" });
    }
    if (rawDays !== undefined && !fullHistory && (!Number.isFinite(days) || days < 1)) {
      return res.status(400).json({ msg: "days must be a positive number or 'all'" });
    }
    if ((from && !isDateKey(from)) || (to && !isDateKey(to))) {
      return res.status(400).json({ msg: "from/to must use YYYY-MM-DD format" });
    }

    const candles = await historyService.cacheHistoricalData(instrumentKey, interval, {
      days,
      fullHistory,
      from,
      to,
      includeIntraday,
    });

    return res.json({
      candles,
      metadata: {
        instrument_key: instrumentKey,
        interval,
        count: candles.length,
        requested_days: days ?? null,
        from: from ?? null,
        to: to ?? null,
        full_history: fullHistory,
      },
    });
  } catch (err) {
    console.error("Historical data error:", err.message);

    if (err.message === "Access token expired") {
      return res.status(401).json({ msg: "Unauthorized - Invalid access token" });
    }
    if (err.message === "Instrument not found") {
      return res.status(404).json({ msg: "Instrument not found or invalid instrument key" });
    }

    return res.status(500).json({ msg: err.message || "Error fetching historical data" });
  }
});

module.exports = router;
