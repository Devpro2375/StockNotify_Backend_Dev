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
    const quotes = {};

    // Try to get data from multiple sources
    for (const instrument of instrumentList) {
      try {
        // First, try to get last tick from Redis (real-time data)
        const lastTick = await redisService.getLastTick(instrument);
        
        if (lastTick) {
          // Extract price from tick data
          const price = lastTick?.fullFeed?.marketFF?.ltpc?.ltp || 
                       lastTick?.fullFeed?.indexFF?.ltpc?.ltp;
          
          if (price) {
            quotes[instrument] = {
              last_price: price,
              ohlc: {
                open: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.open || price,
                high: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.high || price,
                low: lastTick?.fullFeed?.marketFF?.marketOHLC?.ohlc?.low || price,
                close: price
              },
              source: 'realtime'
            };
            continue;
          }
        }

        // Fallback to last close price from Redis
        const lastClose = await redisService.getLastClosePrice(instrument);
        if (lastClose) {
          quotes[instrument] = {
            last_price: lastClose.close,
            ohlc: {
              open: lastClose.open,
              high: lastClose.high,
              low: lastClose.low,
              close: lastClose.close
            },
            source: 'historical'
          };
          continue;
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
          quotes[instrument] = {
            last_price: data.last_price,
            ohlc: data.ohlc,
            source: 'upstox_api'
          };
        } else {
          quotes[instrument] = null;
        }

      } catch (error) {
        console.error(`Failed to fetch quote for ${instrument}:`, error.message);
        quotes[instrument] = null;
      }
    }

    res.json(quotes);
  } catch (error) {
    console.error('Market data API error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
