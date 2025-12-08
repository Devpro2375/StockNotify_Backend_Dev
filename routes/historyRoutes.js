// routes/historyRoutes.js
'use strict';

const express = require('express');
const router = express.Router();
const historyService = require('../services/historyService');

// GET historical data (REST endpoint)
router.get('/historical/:instrumentKey', async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const { interval = 'day' } = req.query;

    if (!instrumentKey) return res.status(400).json({ error: 'instrumentKey required' });

    const candles = await historyService.cacheHistoricalData(instrumentKey, interval);
    res.json({
      success: true,
      data: { candles, count: candles.length, timestamp: Date.now() },
    });
  } catch (err) {
    console.error('History endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
