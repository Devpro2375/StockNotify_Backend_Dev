// controllers/marketDataController.js

const redisService = require("../services/redisService");
const upstoxService = require("../services/upstoxService");
const axios = require("axios");
const config = require("../config/config");

exports.getQuotes = async (req, res) => {
  try {
    const { instruments } = req.query;
    
    if (!instruments) {
      return res.status(400).json({ error: "Instruments parameter required" });
    }

    const instrumentList = instruments.split(',');
    const quotesPromises = instrumentList.map(async (instrument) => {
      try {
        // First, try to get last tick from Redis (real-time data)
        const lastTick = await redisService.getLastTick(instrument);
       
        if (lastTick) {
          // Extract price from tick data
          const price = lastTick?.fullFeed?.marketFF?.ltpc?.ltp ||
                        lastTick?.fullFeed?.indexFF?.ltpc?.ltp;
          
          if (price) {
            return { [instrument]: {
              last_price: price,
              ohlc: {
                open: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.open || price,
                high: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.high || price,
                low: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.low || price,
                close: price
              },
              source: 'realtime'
            }};
          }
        }

        // Fallback to last close price from Redis
        const lastClose = await redisService.getLastClosePrice(instrument);
        if (lastClose) {
          return { [instrument]: {
            last_price: lastClose.close,
            ohlc: {
              open: lastClose.open,
              high: lastClose.high,
              low: lastClose.low,
              close: lastClose.close
            },
            source: 'historical'
          }};
        }

        // Final fallback: Fetch from Upstox API directly
        const response = await axios.get(
          `https://api.upstox.com/v2/market-quote/quotes?instrument_key=${encodeURIComponent(instrument)}`,
          {
            headers: {
              'Authorization': `Bearer ${config.upstoxAccessToken}`,
              'Accept': 'application/json'
            },
            timeout: 5000 // 5 second timeout
          }
        );

        if (response.data && response.data.data && response.data.data[instrument]) {
          const data = response.data.data[instrument];
          return { [instrument]: {
            last_price: data.last_price,
            ohlc: data.ohlc,
            source: 'upstox_api'
          }};
        } else {
          return { [instrument]: null };
        }

      } catch (error) {
        console.error(`Failed to fetch quote for ${instrument}:`, error.message);
        return { [instrument]: null };
      }
    });

    const results = await Promise.all(quotesPromises);
    const quotes = results.reduce((acc, curr) => ({ ...acc, ...curr }), {});

    res.json(quotes);
  } catch (error) {
    console.error('Market data API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
