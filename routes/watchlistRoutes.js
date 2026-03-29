// routes/watchlistRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const wc = require('../controllers/watchlistController');

// ── Cache-Control middleware for watchlist GET routes ──
// Watchlist data includes real-time prices, so no-cache to ensure freshness
// but allow browser to revalidate with conditional requests
function watchlistCacheHeaders(req, res, next) {
  res.set('Cache-Control', 'private, no-cache');
  next();
}

// ── Backward compat FIRST (operates on default list) — must be before /:id ──
router.post('/add',          authMiddleware, wc.addSymbol);
router.post('/remove',       authMiddleware, wc.removeSymbol);
router.post('/ltp-snapshot', authMiddleware, wc.getLtpSnapshot);

// ── Multi-watchlist endpoints — /all and /default before /:id ──
router.get('/all',       authMiddleware, watchlistCacheHeaders, wc.getAllWatchlists);
router.get('/default',   authMiddleware, watchlistCacheHeaders, wc.getDefaultWatchlist);
router.post('/create',   authMiddleware, wc.createWatchlist);

// ── Per-list operations (these have :id param) ──
router.get('/:id',       authMiddleware, watchlistCacheHeaders, wc.getWatchlist);
router.put('/:id',       authMiddleware, wc.renameWatchlist);
router.delete('/:id',    authMiddleware, wc.deleteWatchlist);
router.post('/:id/add',    authMiddleware, wc.addSymbolToWatchlist);
router.post('/:id/remove', authMiddleware, wc.removeSymbolFromWatchlist);

// ── Root GET = default watchlist (backward compat for existing frontend) ──
router.get('/',          authMiddleware, watchlistCacheHeaders, wc.getDefaultWatchlist);

module.exports = router;
