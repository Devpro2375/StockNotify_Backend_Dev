// routes/marketDataRoutes.js
"use strict";

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const marketDataController = require("../controllers/marketDataController");
const axios = require("axios");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");

// Quotes (existing)
router.get("/quotes", authMiddleware, marketDataController.getQuotes);

// Historical candles (Upstox v2 format retained for backward compatibility)
router.get("/historical/:instrumentKey", authMiddleware, async (req, res) => {
  try {
    const { instrumentKey } = req.params;
    const { interval = "day", days = 365 } = req.query;

    const validIntervals = ["1minute", "30minute", "day", "week", "month"];
    if (!validIntervals.includes(interval)) {
      return res
        .status(400)
        .json({
          msg: "Invalid interval. Must be one of: 1minute, 30minute, day, week, month",
        });
    }

    const toDate = new Date();
    const fromDate = new Date();
    fromDate.setDate(toDate.getDate() - parseInt(days, 10));

    const to = toDate.toISOString().split("T")[0];
    const from = fromDate.toISOString().split("T")[0];

    const tokenDoc = await AccessToken.findOne();
    if (!tokenDoc?.token)
      return res.status(401).json({ msg: "Access token not found" });

    console.log(
      `📊 Fetching historical data: ${instrumentKey} | Interval: ${interval} | From: ${from} To: ${to}`
    );

    const upstoxUrl = `${config.upstoxRestUrl}/v2/historical-candle/${instrumentKey}/${interval}/${to}/${from}`;
    const response = await axios.get(upstoxUrl, {
      headers: { Authorization: `Bearer ${tokenDoc.token}` },
      timeout: 10000,
    });

    const raw = response.data?.data?.candles || [];
    const candles = raw
      .map((candle) => {
        const [ts, o, h, l, c, v] = candle || [];
        if (ts == null) return null;
        // v2 returns seconds; ensure ISO date
        return {
          time: new Date(Number(ts) * 1000).toISOString().split("T")[0],
          open: Number(o),
          high: Number(h),
          low: Number(l),
          close: Number(c),
          volume: v ? Number(v) : 0,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.time) - new Date(b.time));

    console.log(`✅ Retrieved ${candles.length} candles for ${instrumentKey}`);

    res.json({
      candles,
      metadata: {
        instrument_key: instrumentKey,
        interval,
        from,
        to,
        count: candles.length,
      },
    });
  } catch (err) {
    console.error("❌ Error fetching historical data:", err.message);

    if (err.response?.status === 401)
      return res
        .status(401)
        .json({ msg: "Unauthorized - Invalid access token" });
    if (err.response?.status === 404)
      return res
        .status(404)
        .json({ msg: "Instrument not found or invalid instrument key" });

    if (err.response?.data?.errors) {
      return res
        .status(err.response.status)
        .json({ msg: "Upstox API Error", errors: err.response.data.errors });
    }

    res.status(500).json({ msg: "Error fetching historical data" });
  }
});

module.exports = router;
