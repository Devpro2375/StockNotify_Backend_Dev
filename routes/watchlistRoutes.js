// routes/watchlistRoutes.js
'use strict';

const express = require('express');
const router = express.Router();

const authMiddleware = require('../middlewares/authMiddleware');
const wc = require('../controllers/watchlistController');

// ── Backward compat FIRST (operates on default list) — must be before /:id ──
router.post('/add',          authMiddleware, wc.addSymbol);
router.post('/remove',       authMiddleware, wc.removeSymbol);
router.post('/ltp-snapshot', authMiddleware, wc.getLtpSnapshot);

// ── Multi-watchlist endpoints — /all and /default before /:id ──
router.get('/all',       authMiddleware, wc.getAllWatchlists);       // GET all lists
router.get('/default',   authMiddleware, wc.getDefaultWatchlist);    // GET default
router.post('/create',   authMiddleware, wc.createWatchlist);        // POST create custom list

// ── Per-list operations (these have :id param) ──
router.get('/:id',       authMiddleware, wc.getWatchlist);           // GET single list with prices
router.put('/:id',       authMiddleware, wc.renameWatchlist);        // PUT rename list
router.delete('/:id',    authMiddleware, wc.deleteWatchlist);        // DELETE custom list
router.post('/:id/add',    authMiddleware, wc.addSymbolToWatchlist);
router.post('/:id/remove', authMiddleware, wc.removeSymbolFromWatchlist);

// ── Root GET = default watchlist (backward compat for existing frontend) ──
router.get('/',          authMiddleware, wc.getDefaultWatchlist);

module.exports = router;
