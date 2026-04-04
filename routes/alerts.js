// routes/alerts.js
"use strict";

const express = require("express");
const { body, validationResult } = require("express-validator");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");

const {
  getAlerts,
  addAlert,
  removeAlert,
} = require("../controllers/alertsController");

// Validation error handler
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ message: "Validation failed", errors: errors.array() });
  }
  next();
};

// Fetch all alerts for current user
router.get("/", auth, (req, res) => getAlerts(req, res));

// Add a new alert
router.post(
  "/add",
  auth,
  [
    body("instrument_key").notEmpty().withMessage("instrument_key is required"),
    body("trading_symbol").notEmpty().withMessage("trading_symbol is required"),
    body("entry_price").isNumeric().withMessage("entry_price must be a number"),
    body("stop_loss").isNumeric().withMessage("stop_loss must be a number"),
    body("target_price").isNumeric().withMessage("target_price must be a number"),
    body("position").isIn(["long", "short"]).withMessage("position must be long or short"),
    body("trade_type").isIn(["QIT", "MIT", "WIT", "DIT", "HIT"]).withMessage("Invalid trade_type"),
  ],
  validate,
  (req, res) => addAlert(req, res)
);

// Remove an alert by id
router.post(
  "/remove",
  auth,
  [body("id").notEmpty().withMessage("Alert id is required")],
  validate,
  (req, res) => removeAlert(req, res)
);

module.exports = router;
