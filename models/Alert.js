// models/Alert.js

const mongoose = require("mongoose");

const alertSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  trading_symbol: { type: String, required: true },
  instrument_key: { type: String, required: true },
  cmp: { type: Number },
  entry_price: { type: Number, required: true, min: 0.01 },
  stop_loss: { type: Number, required: true, min: 0.01 },
  target_price: { type: Number, required: true, min: 0.01 },
  position: { type: String, enum: ["long", "short"] },
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
  entry_crossed: { type: Boolean, default: false },
  created_at: { type: Date, default: Date.now },
});

// ── Compound indexes for high-frequency query patterns ──
// Alert processing: finds active alerts by instrument_key (every tick)
alertSchema.index({ instrument_key: 1, status: 1 });
// User queries: fetches alerts by user + status (socket connect, API)
alertSchema.index({ user: 1, status: 1 });
// Cleanup queries: finds alerts by instrument_key for count checks
alertSchema.index({ user: 1, instrument_key: 1, status: 1 });

// ── Pre-validate: enforce stop_loss direction relative to entry_price ──
alertSchema.pre('validate', function(next) {
  if (this.entry_price && this.stop_loss && this.target_price) {
    if (this.position === 'long') {
      if (this.stop_loss >= this.entry_price) {
        return next(new Error('Long trade: stop_loss must be below entry_price'));
      }
    } else if (this.position === 'short') {
      if (this.stop_loss <= this.entry_price) {
        return next(new Error('Short trade: stop_loss must be above entry_price'));
      }
    }
  }
  next();
});

module.exports = mongoose.model("Alert", alertSchema);
