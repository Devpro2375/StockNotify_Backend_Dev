// models/Watchlist.js

const mongoose = require("mongoose");

const watchlistSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  symbols: [
    {
      instrument_key: { type: String, required: true },
      trading_symbol: { type: String, required: true },
    },
  ],
});

module.exports = mongoose.model("Watchlist", watchlistSchema);
