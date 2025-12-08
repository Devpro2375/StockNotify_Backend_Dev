// routes/alerts.js
"use strict";

const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");

const {
  getAlerts,
  addAlert,
  removeAlert,
} = require("../controllers/alertsController");

// Fetch all alerts for current user
router.get("/", auth, (req, res) => getAlerts(req, res));

// Add a new alert
router.post("/add", auth, (req, res) => addAlert(req, res));

// Remove an alert by id
router.post("/remove", auth, (req, res) => removeAlert(req, res));

module.exports = router;
