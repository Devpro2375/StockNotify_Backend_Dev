// controllers/alertsController.js
"use strict";

const Alert = require("../models/Alert");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const { STATUSES } = require("../services/constants");

/**
 * GET /api/alerts
 * Return all alerts for authenticated user, with `cmp` hydrated from cache/API.
 */
exports.getAlerts = async (req, res) => {
  try {
    const alerts = await Alert.find({ user: req.user.id }).sort({
      created_at: -1,
    });

    const alertsWithCmp = await Promise.all(
      alerts.map(async (alert) => {
        let lastPrice = await redisService.getLastClosePrice(
          alert.instrument_key
        );
        if (!lastPrice) {
          // Hardened: tolerate upstream errors
          try {
            lastPrice = await upstoxService.fetchLastClose(
              alert.instrument_key
            );
          } catch {
            lastPrice = null;
          }
        }

        const obj = alert.toObject();
        obj.cmp = lastPrice?.close ?? obj.cmp ?? null;
        return obj;
      })
    );

    res.json({ alerts: alertsWithCmp });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/alerts/add
 * Create a new alert for the authenticated user.
 */
exports.addAlert = async (req, res) => {
  try {
    const {
      trading_symbol,
      instrument_key,
      entry_price,
      stop_loss,
      target_price,
      position,
      trade_type,
      level,
      sector,
      notes,
    } = req.body;

    // Validation – typed & present
    if (
      !trading_symbol ||
      !instrument_key ||
      entry_price == null ||
      stop_loss == null ||
      target_price == null ||
      !position ||
      !trade_type ||
      level == null
    ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const numericFields = [
      "entry_price",
      "stop_loss",
      "target_price",
      "level",
    ].every((k) => Number.isFinite(Number(req.body[k])));
    if (!numericFields) {
      return res.status(400).json({ message: "Invalid numeric fields" });
    }

    const newAlert = new Alert({
      user: req.user.id,
      trading_symbol,
      instrument_key,
      entry_price: Number(entry_price),
      stop_loss: Number(stop_loss),
      target_price: Number(target_price),
      position,
      trade_type,
      level: Number(level),
      sector,
      notes,
      status: STATUSES.PENDING,
      entry_crossed: false,
    });

    await newAlert.save();

    // Mark as persistent to ensure background processing even if user disconnects
    await redisService.addPersistentStock(newAlert.instrument_key);

    // Subscribe if needed (first subscriber or persistent)
    if (await redisService.shouldSubscribe(newAlert.instrument_key)) {
      upstoxService.subscribe([newAlert.instrument_key]);
      console.log(`🌐 Subscribed to ${newAlert.instrument_key} for new alert`);
    }

    res.json({ alert: newAlert });
  } catch (err) {
    console.error("Error adding alert:", err);
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/alerts/remove
 * Remove an alert by ID.
 */
exports.removeAlert = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "Alert ID required" });

    const alert = await Alert.findById(id);
    if (!alert || alert.user.toString() !== req.user.id) {
      return res.status(404).json({ message: "Alert not found" });
    }

    await Alert.findByIdAndDelete(id);

    // If nobody else needs this symbol, remove persistence & unsubscribe
    const activeAlerts = await Alert.countDocuments({
      instrument_key: alert.instrument_key,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });

    if (
      activeAlerts === 0 &&
      (await redisService.getStockUserCount(alert.instrument_key)) === 0
    ) {
      await redisService.removePersistentStock(alert.instrument_key);
      upstoxService.unsubscribe([alert.instrument_key]);
      console.log(
        `❎ Unsubscribed and removed persistent for ${alert.instrument_key}`
      );
    }

    res.json({ message: "Alert removed" });
  } catch (err) {
    console.error("Error removing alert:", err);
    res.status(500).json({ message: "Server error" });
  }
};
