// models/Watchlist.js

const mongoose = require("mongoose");

const watchlistSchema = new mongoose.Schema(
  {
    user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    name: { type: String, required: true, default: "My Stocks" },
    type: { type: String, enum: ["default", "custom"], default: "default" },
    order: { type: Number, default: 0 },
    symbols: [
      {
        instrument_key: { type: String, required: true },
        trading_symbol: { type: String, required: true },
      },
    ],
  },
  { timestamps: true }
);

// One watchlist name per user
watchlistSchema.index({ user: 1, name: 1 }, { unique: true });
watchlistSchema.index({ user: 1, order: 1 });

module.exports = mongoose.model("Watchlist", watchlistSchema);
