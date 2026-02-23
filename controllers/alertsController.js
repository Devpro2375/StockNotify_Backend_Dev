// controllers/alertsController.js
"use strict";

const Alert = require("../models/Alert");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const { STATUSES } = require("../services/constants");
const logger = require("../utils/logger");
const { refreshAlertCache } = require("../services/alertService");

/**
 * GET /api/alerts
 * Return all alerts for authenticated user, with `cmp` hydrated from cache/API.
 * REFACTORED: Uses batch Redis lookup instead of N sequential calls.
 */
exports.getAlerts = async (req, res) => {
  try {
    const alerts = await Alert.find({ user: req.user.id }).sort({ created_at: -1 });

    // Batch fetch close prices in one Redis round-trip
    const instrumentKeys = [...new Set(alerts.map((a) => a.instrument_key))];
    const closePrices = await redisService.getLastClosePriceBatch(instrumentKeys);

    // For any missing prices, fetch from API in parallel
    const missing = instrumentKeys.filter((k) => !closePrices[k]);
    if (missing.length) {
      const fetched = await Promise.allSettled(
        missing.map((k) => upstoxService.fetchLastClose(k))
      );
      for (let i = 0; i < missing.length; i++) {
        if (fetched[i].status === "fulfilled" && fetched[i].value) {
          closePrices[missing[i]] = fetched[i].value;
        }
      }
    }

    const alertsWithCmp = alerts.map((alert) => {
      const obj = alert.toObject();
      obj.cmp = closePrices[alert.instrument_key]?.close ?? obj.cmp ?? null;
      return obj;
    });

    res.json({ alerts: alertsWithCmp });
  } catch (err) {
    logger.error("Error fetching alerts", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/alerts/add
 */
exports.addAlert = async (req, res) => {
  try {
    const {
      trading_symbol, instrument_key, entry_price, stop_loss,
      target_price, position, trade_type, level, sector, notes,
    } = req.body;

    if (
      !trading_symbol || !instrument_key ||
      entry_price == null || stop_loss == null || target_price == null ||
      !position || !trade_type || level == null
    ) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const numericValid = ["entry_price", "stop_loss", "target_price", "level"]
      .every((k) => Number.isFinite(Number(req.body[k])));
    if (!numericValid) {
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

    // Mark persistent + subscribe in parallel
    await redisService.addPersistentStock(newAlert.instrument_key);
    if (await redisService.shouldSubscribe(newAlert.instrument_key)) {
      upstoxService.subscribe([newAlert.instrument_key]);
      logger.info(`Subscribed to ${newAlert.instrument_key} for new alert`);
    }

    // Immediately refresh alert cache so new alert is active on next tick
    refreshAlertCache().catch((err) =>
      logger.error("Cache refresh after addAlert failed", { error: err.message })
    );

    res.json({ alert: newAlert });
  } catch (err) {
    logger.error("Error adding alert", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/alerts/remove
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

    // Check if symbol still needed
    const activeAlerts = await Alert.countDocuments({
      instrument_key: alert.instrument_key,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });

    if (activeAlerts === 0 && (await redisService.getStockUserCount(alert.instrument_key)) === 0) {
      await redisService.removePersistentStock(alert.instrument_key);
      upstoxService.unsubscribe([alert.instrument_key]);
      logger.info(`Unsubscribed and removed persistent for ${alert.instrument_key}`);
    }

    // Immediately refresh alert cache so deleted alert stops processing
    refreshAlertCache().catch((err) =>
      logger.error("Cache refresh after removeAlert failed", { error: err.message })
    );

    res.json({ message: "Alert removed" });
  } catch (err) {
    logger.error("Error removing alert", { error: err.message });
    res.status(500).json({ message: "Server error" });
  }
};
