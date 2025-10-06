// models/Alert.js

const mongoose = require("mongoose");

const alertSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  trading_symbol: { type: String, required: true },
  instrument_key: { type: String, required: true },
  cmp: { type: Number },
  entry_price: { type: Number, required: true },
  stop_loss: { type: Number, required: true },
  target_price: { type: Number, required: true },
  trend: { type: String, enum: ["bullish", "bearish"], required: true },
  trade_type: {
    type: String,
    enum: ["intraday", "swing", "positional"],
    required: true,
  },
  level: { type: String, enum: ["4", "5", "6", "7"], required: true },
  sector: { type: String },
  notes: { type: String },
  status: {
    type: String,
    enum: ["pending", "nearEntry", "enter", "running", "slHit", "targetHit"],
    default: "pending",
  },
  last_ltp: { type: Number, default: null },
  entry_crossed: { type: Boolean, default: false }, // NEW: Track if entry was ever crossed
  created_at: { type: Date, default: Date.now },
});

module.exports = mongoose.model("Alert", alertSchema);
