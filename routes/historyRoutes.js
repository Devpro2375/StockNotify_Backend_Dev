// routes/historyRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const historyService = require('../services/historyService');

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

// GET historical data (REST endpoint)
router.get('/historical/:instrumentKey', async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const interval = String(req.query.interval || 'day');
    const rawDays = req.query.days;
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

    const candles = await historyService.cacheHistoricalData(instrumentKey, interval, {
      days,
      fullHistory,
    });
    res.json({
      success: true,
      data: {
        candles,
        count: candles.length,
        timestamp: Date.now(),
        interval,
        requested_days: days ?? null,
        full_history: fullHistory,
      },
    });
  } catch (err) {
    console.error('History endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
