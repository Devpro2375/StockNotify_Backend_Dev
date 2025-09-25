// routes/alerts.js

const express = require("express");
const router = express.Router();
const auth = require("../middlewares/authMiddleware");
const {
  getAlerts,
  addAlert,
  removeAlert
} = require("../controllers/alertsController");

// Fetch all alerts for current user
router.get("/", auth, async (req, res) => {
  try {
    await getAlerts(req, res);
  } catch (error) {
    console.error("Error in getAlerts route:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Add a new alert
router.post("/add", auth, async (req, res) => {
  try {
    await addAlert(req, res);
  } catch (error) {
    console.error("Error in addAlert route:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Remove an alert by id or instrument_key
router.post("/remove", auth, async (req, res) => {
  try {
    await removeAlert(req, res);
  } catch (error) {
    console.error("Error in removeAlert route:", error);
    res.status(500).json({ message: "Internal server error" });
  }
});

module.exports = router;
