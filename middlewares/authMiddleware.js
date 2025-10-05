// middlewares/authMiddleware.js
const jwt = require('jsonwebtoken');
const config = require('../config/config');

// Simple in-memory cache for validated tokens (optional but helpful)
const tokenCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

module.exports = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  
  if (!token) {
    return res.status(401).json({ msg: 'No token, authorization denied' });
  }

  try {
    // OPTIMIZATION 1: Check cache first
    const cached = tokenCache.get(token);
    if (cached && cached.expiresAt > Date.now()) {
      req.user = cached.user;
      return next();
    }

    // OPTIMIZATION 2: Verify token
    const decoded = jwt.verify(token, config.jwtSecret);
    req.user = decoded.user;
    
    // Cache the decoded token
    tokenCache.set(token, {
      user: decoded.user,
      expiresAt: Date.now() + CACHE_TTL
    });
    
    next();
  } catch (err) {
    // Clear from cache if invalid
    tokenCache.delete(token);
    
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token expired', expired: true });
    }
    res.status(401).json({ msg: 'Token is not valid' });
  }
};

// Cleanup cache periodically (prevent memory leak)
setInterval(() => {
  const now = Date.now();
  for (const [token, data] of tokenCache.entries()) {
    if (data.expiresAt < now) {
      tokenCache.delete(token);
    }
  }
}, 60000); // Clean every minute
