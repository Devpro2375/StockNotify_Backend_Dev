const Alert = require("../models/Alert");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const { STATUSES } = require("../services/socketService");

// Get all alerts for the current user
exports.getAlerts = async (req, res) => {
  try {
    const alerts = await Alert.find({ user: req.user.id }).sort({ created_at: -1 });
    res.json({ alerts });
  } catch (err) {
    console.error("Error fetching alerts:", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Add a new alert
exports.addAlert = async (req, res) => {
  try {
    // Validate required fields (add more as needed)
    const {
      trading_symbol,
      instrument_key,
      entry_price,
      stop_loss,
      target_price,
      trend,
      trade_type,
      level,
      sector,
      notes
    } = req.body;

    if (!trading_symbol || !instrument_key || !entry_price || !stop_loss || !target_price || !trend || !trade_type || !level) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    const newAlert = new Alert({
      user: req.user.id,
      trading_symbol,
      instrument_key,
      entry_price,
      stop_loss,
      target_price,
      trend,
      trade_type,
      level,
      sector,
      notes,
      status: STATUSES.PENDING  // Default to pending
    });

    await newAlert.save();

    // NEW: Add to persistent stocks for offline processing
    await redisService.addPersistentStock(newAlert.instrument_key);

    // NEW: Subscribe if not already (for immediate tick flow)
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

// Remove an alert
exports.removeAlert = async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ message: "Alert ID required" });

    const removedAlert = await Alert.findById(id);
    if (!removedAlert || removedAlert.user.toString() !== req.user.id) {
      return res.status(404).json({ message: "Alert not found" });
    }

    await Alert.findByIdAndDelete(id);

    // NEW: Check if symbol can be removed from persistent
    const activeAlerts = await Alert.countDocuments({
      instrument_key: removedAlert.instrument_key,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
    });
    if (activeAlerts === 0 && (await redisService.getStockUserCount(removedAlert.instrument_key)) === 0) {
      await redisService.removePersistentStock(removedAlert.instrument_key);
      upstoxService.unsubscribe([removedAlert.instrument_key]);
      console.log(`❎ Unsubscribed and removed persistent for ${removedAlert.instrument_key}`);
    }

    res.json({ message: "Alert removed" });
  } catch (err) {
    console.error("Error removing alert:", err);
    res.status(500).json({ message: "Server error" });
  }
};
