const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');

/**
 * Downloads and updates instrument data from Upstox
 */
async function updateInstruments() {
  try {
    console.log('📥 Downloading instruments from Upstox...');

    // Download all exchanges
    const exchanges = ['NSE', 'BSE', 'NFO', 'MCX', 'BFO', 'CDS'];
    let allInstruments = [];

    for (const exchange of exchanges) {
      try {
        const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
        
        console.log(`📡 Fetching ${exchange}...`);
        
        // Download gzipped data - axios auto-handles decompression
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: {
            'Accept-Encoding': 'gzip, deflate'
          },
          // CRITICAL: Disable auto-decompression for .gz files
          decompress: false
        });

        console.log(`📦 Decompressing ${exchange}...`);
        
        // Manually decompress the gzipped data
        const decompressed = gunzipSync(Buffer.from(response.data));
        const instruments = JSON.parse(decompressed.toString('utf-8'));
        
        // Normalize trading symbols to uppercase for faster searches
        const normalizedInstruments = instruments.map(inst => ({
          ...inst,
          trading_symbol: inst.trading_symbol.toUpperCase(),
        }));

        allInstruments = allInstruments.concat(normalizedInstruments);
        console.log(`✅ Downloaded ${instruments.length} instruments from ${exchange}`);
      } catch (error) {
        console.error(`❌ Failed to download ${exchange}:`, error.message);
        // Continue with other exchanges even if one fails
      }
    }

    if (allInstruments.length === 0) {
      throw new Error('No instruments downloaded from any exchange');
    }

    console.log(`💾 Updating MongoDB with ${allInstruments.length} total instruments...`);

    // Get MongoDB database - ensure connection exists
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = process.env.INSTRUMENTS_COLLECTION || 'instruments';
    const collection = db.collection(collectionName);

    console.log(`🗑️ Clearing existing instruments from ${collectionName}...`);
    
    // Delete all existing instruments
    const deleteResult = await collection.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} old instruments`);

    // Insert in batches of 1000 for better performance
    const batchSize = 1000;
    let totalInserted = 0;
    
    for (let i = 0; i < allInstruments.length; i += batchSize) {
      const batch = allInstruments.slice(i, i + batchSize);
      try {
        await collection.insertMany(batch, { ordered: false });
        totalInserted += batch.length;
        console.log(`✅ Inserted batch ${Math.floor(i / batchSize) + 1}: ${totalInserted}/${allInstruments.length}`);
      } catch (error) {
        console.error(`❌ Error inserting batch at position ${i}:`, error.message);
        // Continue with remaining batches
      }
    }

    console.log(`✅ Successfully inserted ${totalInserted} instruments into MongoDB`);

    // Clear Redis cache after update (with error handling)
    try {
      const redisService = require('./redisService');
      if (redisService && redisService.redis) {
        const keys = await redisService.redis.keys('instrument:*');
        if (keys.length > 0) {
          await redisService.redis.del(...keys);
          console.log(`🗑️ Cleared ${keys.length} instrument cache entries from Redis`);
        }
      }
    } catch (redisError) {
      console.warn('⚠️ Could not clear Redis cache (non-critical):', redisError.message);
      // Don't fail the whole operation if Redis cleanup fails
    }

    return { 
      success: true, 
      count: totalInserted,
      deleted: deleteResult.deletedCount 
    };
  } catch (error) {
    console.error('❌ Instrument update failed:', error);
    throw error;
  }
}

module.exports = { updateInstruments };
