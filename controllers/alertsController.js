// controllers/alertsController.js
const Alert = require("../models/Alert");
const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
// FIXED: Import STATUSES from alertService instead of socketService
const { STATUSES } = require("../services/alertService");

async function getAlerts(req, res) {
  try {
    const alerts = await Alert.find({ user: req.user.id });
    // FIXED: Return object with alerts property to match frontend expectation
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function addAlert(req, res) {
  try {
    const alert = new Alert({
      ...req.body,
      user: req.user.id,
      status: STATUSES.PENDING
    });
    await alert.save();

    const symbol = alert.instrument_key;
    await redisService.addPersistentStock(symbol);
    const userCount = await redisService.getStockUserCount(symbol);
    if (userCount === 0) {
      upstoxService.subscribe([symbol]);
      console.log(`Persistent subscription added for ${symbol}`);
    }

    // FIXED: Return object with alert property to match frontend expectation
    res.status(201).json({ alert });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

async function removeAlert(req, res) {
  try {
    const { id, instrument_key } = req.body;
    const query = id ? { _id: id } : { instrument_key, user: req.user.id };
    const deleted = await Alert.findOneAndDelete(query);

    if (!deleted) {
      return res.status(404).json({ message: "Alert not found" });
    }

    const symbol = deleted.instrument_key;
    const remainingAlerts = await Alert.countDocuments({
      instrument_key: symbol,
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] }
    });
    
    if (remainingAlerts === 0) {
      await redisService.removePersistentStock(symbol);
      const userCount = await redisService.getStockUserCount(symbol);
      if (userCount === 0) {
        upstoxService.unsubscribe([symbol]);
        console.log(`Persistent subscription removed for ${symbol}`);
      }
    }

    res.json({ message: "Alert removed" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
}

module.exports = { getAlerts, addAlert, removeAlert };
