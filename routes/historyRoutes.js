// routes/historyRoutes.js
'use strict';

const crypto = require('crypto');
const express = require('express');
const router = express.Router();
const historyService = require('../services/historyService');
const asyncHandler = require('../utils/asyncHandler');

// ── Helper: cheap ETag from candle count + first/last timestamps ──
function computeETag(candles) {
  if (!candles.length) return '"empty"';
  const sig = `${candles.length}:${candles[0].time}:${candles[candles.length - 1].time}`;
  return `"${crypto.createHash('md5').update(sig).digest('hex').slice(0, 16)}"`;
}

// GET historical data (REST endpoint)
router.get('/historical/:instrumentKey', asyncHandler(async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const { interval = 'day' } = req.query;

    if (!instrumentKey) return res.status(400).json({ error: 'instrumentKey required' });

    const candles = await historyService.cacheHistoricalData(instrumentKey, interval);

    // ── ETag-based conditional response ──
    const etag = computeETag(candles);
    res.set('ETag', etag);

    // Determine cache duration based on market hours
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const day = now.getDay();
    const totalMin = now.getHours() * 60 + now.getMinutes();
    const marketOpen = day > 0 && day < 6 && totalMin >= 555 && totalMin <= 930;
    const maxAge = marketOpen ? 60 : 300;

    res.set('Cache-Control', `private, max-age=${maxAge}`);

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    res.json({
      success: true,
      data: { candles, count: candles.length, timestamp: Date.now() },
    });
  } catch (err) {
    console.error('History endpoint error:', err.message);
    res.status(500).json({ error: "Failed to fetch historical data" });
  }
}));

module.exports = router;
