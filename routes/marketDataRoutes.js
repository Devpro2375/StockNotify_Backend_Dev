// routes/marketDataRoutes.js
"use strict";

const express = require("express");
const router = express.Router();

const authMiddleware = require("../middlewares/authMiddleware");
const marketDataController = require("../controllers/marketDataController");
const axios = require("axios");
const config = require("../config/config");
const AccessToken = require("../models/AccessToken");

// ── In-memory cache for historical candles ──
const histCache = new Map(); // key -> { data, expiry }
const HIST_CACHE_TTL = 2 * 60_000; // 2 min
const MAX_HIST_CACHE = 80;

// ── Cached token (avoids a DB query per request) ──
let _cachedToken = null;
let _tokenExpiry = 0;
const TOKEN_TTL = 5 * 60_000;

async function getCachedToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;
  const tokenDoc = await AccessToken.findOne({}, { token: 1 }).lean();
  if (!tokenDoc?.token) return null;
  _cachedToken = tokenDoc.token;
  _tokenExpiry = Date.now() + TOKEN_TTL;
  return _cachedToken;
}

// ── Request deduplication ──
const inflightHist = new Map();

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

    const cacheKey = `mdhist:${instrumentKey}:${interval}:${days}`;

    // ── Check in-memory cache ──
    const cached = histCache.get(cacheKey);
    if (cached && Date.now() < cached.expiry) {
      res.set("X-Cache", "HIT");
      res.set("Cache-Control", "private, max-age=120");
      return res.json(cached.data);
    }

    // ── Deduplicate concurrent identical requests ──
    if (inflightHist.has(cacheKey)) {
      const result = await inflightHist.get(cacheKey);
      res.set("X-Cache", "DEDUP");
      res.set("Cache-Control", "private, max-age=120");
      return res.json(result);
    }

    const promise = fetchHistorical(instrumentKey, interval, days);
    inflightHist.set(cacheKey, promise);

    let result;
    try {
      result = await promise;
    } finally {
      inflightHist.delete(cacheKey);
    }

    // Store in cache
    histCache.set(cacheKey, { data: result, expiry: Date.now() + HIST_CACHE_TTL });
    if (histCache.size > MAX_HIST_CACHE) {
      const now = Date.now();
      for (const [k, v] of histCache) {
        if (v.expiry < now) histCache.delete(k);
      }
    }

    res.set("X-Cache", "MISS");
    res.set("Cache-Control", "private, max-age=120");
    res.json(result);
  } catch (err) {
    console.error("Error fetching historical data:", err.message);

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

async function fetchHistorical(instrumentKey, interval, days) {
  const toDate = new Date();
  const fromDate = new Date();
  fromDate.setDate(toDate.getDate() - parseInt(days, 10));

  const to = toDate.toISOString().split("T")[0];
  const from = fromDate.toISOString().split("T")[0];

  const token = await getCachedToken();
  if (!token) throw Object.assign(new Error("Access token not found"), { response: { status: 401 } });

  const upstoxUrl = `${config.upstoxRestUrl}/v2/historical-candle/${instrumentKey}/${interval}/${to}/${from}`;
  const response = await axios.get(upstoxUrl, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });

  const raw = response.data?.data?.candles || [];
  const candles = raw
    .map((candle) => {
      const [ts, o, h, l, c, v] = candle || [];
      if (ts == null) return null;
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

  return {
    candles,
    metadata: {
      instrument_key: instrumentKey,
      interval,
      from,
      to,
      count: candles.length,
    },
  };
}

module.exports = router;
