// C:\Users\deves\Desktop\Upstox API Trials\Backend_Github\controllers\alertsController.js

const Alert = require("../models/Alert");

// GET /api/alerts
exports.getAlerts = async (req, res) => {
  try {
    const alerts = await Alert.find({ user: req.user.id }).sort({
      created_at: -1,
    });
    res.json({ alerts });
  } catch (err) {
    console.error("Error in getAlerts:", err.message);
    res.status(500).send("Server error");
  }
};

// POST /api/alerts/add
exports.addAlert = async (req, res) => {
  const {
    trading_symbol,
    instrument_key,
    cmp, // Now optional
    entry_price,
    stop_loss,
    target_price,
    trend,
    trade_type,
    level,
    sector,
    notes,
  } = req.body;

  // Basic validation (removed cmp check to make it optional)
  if (
    !trading_symbol ||
    !instrument_key ||
    typeof entry_price !== "number" ||
    typeof stop_loss !== "number" ||
    typeof target_price !== "number" ||
    !trend ||
    !trade_type ||
    !level
  ) {
    return res.status(400).json({
      msg: "All required fields must be provided and numeric values must be valid",
    });
  }

  // Trend-dependent price validation
  if (trend === "bullish") {
    if (stop_loss >= entry_price || target_price <= entry_price) {
      return res.status(400).json({
        msg: "For bullish: Stop loss must be below entry and target must be above entry",
      });
    }
  } else if (trend === "bearish") {
    if (stop_loss <= entry_price || target_price >= entry_price) {
      return res.status(400).json({
        msg: "For bearish: Stop loss must be above entry and target must be below entry",
      });
    }
  }

  try {
    const newAlert = new Alert({
      user: req.user.id,
      trading_symbol,
      instrument_key,
      cmp, // Can be undefined or null
      entry_price,
      stop_loss,
      target_price,
      trend,
      trade_type,
      level,
      sector,
      notes,
    });

    const alert = await newAlert.save();
    res.json({ alert });
  } catch (err) {
    console.error("Error in addAlert:", err.message);
    res.status(500).send("Server error");
  }
};

// POST /api/alerts/remove
exports.removeAlert = async (req, res) => {
  const { id, instrument_key } = req.body;
  if (!id && !instrument_key) {
    return res.status(400).json({ msg: "Alert ID or instrument_key required" });
  }

  try {
    const query = { user: req.user.id };
    if (id) query._id = id;
    else query.instrument_key = instrument_key;

    const alert = await Alert.findOneAndDelete(query);
    if (!alert) return res.status(404).json({ msg: "Alert not found" });

    res.json({ msg: "Alert removed", alert });
  } catch (err) {
    console.error("Error in removeAlert:", err.message);
    res.status(500).send("Server error");
  }
};
