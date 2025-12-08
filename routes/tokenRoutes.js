// routes/tokenRoutes.js
"use strict";

const express = require("express");
const router = express.Router();
const AccessToken = require("../models/AccessToken");

// Get token status
router.get("/status", async (req, res) => {
  try {
    const tokenDoc = await AccessToken.findOne().lean();
    if (!tokenDoc?.token) {
      return res.status(404).json({
        status: "error",
        message: "No access token found in database",
        hasToken: false,
      });
    }

    const now = new Date();
    const expiresAt = tokenDoc.expires_at
      ? new Date(tokenDoc.expires_at)
      : null;
    const isExpired = expiresAt ? now > expiresAt : false;

    let timeUntilExpiry = null;
    if (expiresAt) {
      const diff = expiresAt - now;
      timeUntilExpiry = {
        hours: Math.floor(diff / (1000 * 60 * 60)),
        minutes: Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)),
        total_minutes: Math.floor(diff / (1000 * 60)),
      };
    }

    res.json({
      status: isExpired ? "expired" : "active",
      hasToken: true,
      user: {
        name: tokenDoc.user_name,
        email: tokenDoc.email,
        id: tokenDoc.user_id,
        broker: tokenDoc.broker,
      },
      updated_at: tokenDoc.updated_at,
      expires_at: tokenDoc.expires_at,
      is_expired: isExpired,
      time_until_expiry: timeUntilExpiry,
      metadata: tokenDoc.metadata,
    });
  } catch (err) {
    console.error("Error fetching token status:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
});

// Health check endpoint
router.get("/health", async (req, res) => {
  try {
    const tokenDoc = await AccessToken.findOne()
      .select("expires_at updated_at")
      .lean();
    if (!tokenDoc)
      return res
        .status(503)
        .json({ healthy: false, reason: "No token in database" });

    const now = new Date();
    const expiresAt = tokenDoc.expires_at
      ? new Date(tokenDoc.expires_at)
      : null;
    const isExpired = expiresAt ? now > expiresAt : false;
    const hoursUntilExpiry = expiresAt
      ? Math.floor((expiresAt - now) / (1000 * 60 * 60))
      : null;

    const healthy =
      !isExpired && (hoursUntilExpiry == null || hoursUntilExpiry > 1);

    res.json({
      healthy,
      is_expired: isExpired,
      hours_until_expiry: hoursUntilExpiry,
      last_updated: tokenDoc.updated_at,
    });
  } catch (err) {
    res.status(500).json({ healthy: false, reason: err.message });
  }
});

// Manual token refresh (testing)
router.post("/refresh", async (req, res) => {
  try {
    console.log("\n╔════════════════════════════════════════════════╗");
    console.log("║   🧪 MANUAL TOKEN REFRESH TRIGGERED           ║");
    console.log("╚════════════════════════════════════════════════╝\n");

    const UpstoxTokenRefresh = require("../services/upstoxTokenRefresh");
    const refresher = new UpstoxTokenRefresh();
    const result = await refresher.refreshToken();

    if (result.success) {
      console.log("✅ Manual refresh completed successfully!\n");
      res.json({
        success: true,
        message: "Token refreshed successfully",
        expires_at: result.expiresAt,
        note: result.note,
      });
    } else {
      console.error("❌ Manual refresh failed!\n");
      res.status(500).json({ success: false, error: result.error });
    }
  } catch (err) {
    console.error("❌ Manual refresh error:", err.message, "\n");
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
