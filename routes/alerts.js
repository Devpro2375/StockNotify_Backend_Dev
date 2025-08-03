// C:\Users\deves\Desktop\Upstox API Trials\Backend_Github\routes\alerts.js

const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const {
  getAlerts,
  addAlert,
  removeAlert
} = require("../controllers/alertsController");

// Fetch all alerts for current user
router.get("/", auth, getAlerts);

// Add a new alert
router.post("/add", auth, addAlert);

// Remove an alert by id or instrument_key
router.post("/remove", auth, removeAlert);

module.exports = router;
