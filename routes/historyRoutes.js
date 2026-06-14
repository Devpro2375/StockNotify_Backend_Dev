// routes/historyRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const historyService = require('../services/historyService');
const authMiddleware = require('../middlewares/authMiddleware');

const allowedIntervals = new Set([
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

function parseBooleanFlag(value, defaultValue = false) {
  if (value === undefined) return defaultValue;
  const normalized = String(value).toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// Backward-compatible historical endpoint. Canonical path is
// /api/market-data/historical/:instrumentKey, but this alias must still be auth-protected.
router.get('/historical/:instrumentKey', authMiddleware, async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const interval = String(req.query.interval || 'day');
    const rawDays = req.query.days;
    const from = typeof req.query.from === "string" ? req.query.from : undefined;
    const to = typeof req.query.to === "string" ? req.query.to : undefined;
    const includeIntraday = parseBooleanFlag(req.query.includeIntraday, true);
    const fullHistory =
      String(req.query.fullHistory || '').toLowerCase() === 'true' ||
      String(req.query.fullHistory || '') === '1' ||
      String(rawDays || '').toLowerCase() === 'all';
    const days = rawDays === undefined || fullHistory ? undefined : Number(rawDays);

    if (!instrumentKey) return res.status(400).json({ error: 'instrumentKey required' });
    if (!allowedIntervals.has(interval)) {
      return res.status(400).json({ error: 'Unsupported interval' });
    }
    if (rawDays !== undefined && !fullHistory && (!Number.isFinite(days) || days < 1)) {
      return res.status(400).json({ error: "days must be a positive number or 'all'" });
    }
    if ((from && !isDateKey(from)) || (to && !isDateKey(to))) {
      return res.status(400).json({ error: "from/to must use YYYY-MM-DD format" });
    }

    const candles = await historyService.cacheHistoricalData(instrumentKey, interval, {
      days,
      fullHistory,
      from,
      to,
      includeIntraday,
    });
    res.json({
      success: true,
      data: {
        candles,
        count: candles.length,
        timestamp: Date.now(),
        interval,
        requested_days: days ?? null,
        from: from ?? null,
        to: to ?? null,
        full_history: fullHistory,
      },
    });
  } catch (err) {
    console.error('History endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
