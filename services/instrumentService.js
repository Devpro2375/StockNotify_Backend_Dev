// services/instrumentService.js - REFACTORED & OPTIMIZED

const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');

const EXCHANGES = ['NSE', 'BSE', 'NFO', 'MCX', 'BFO', 'CDS'];
const BATCH_SIZE = 1000;
const DOWNLOAD_TIMEOUT = 30000;

async function downloadExchange(exchange) {
  try {
    const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
    console.log(`📡 Fetching ${exchange}...`);
    
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: DOWNLOAD_TIMEOUT,
      headers: { 'Accept-Encoding': 'gzip, deflate' },
      decompress: false
    });

    console.log(`📦 Decompressing ${exchange}...`);
    const decompressed = gunzipSync(Buffer.from(response.data));
    const instruments = JSON.parse(decompressed.toString('utf-8'));
    
    // Normalize to uppercase for faster searches
    const normalized = instruments.map(inst => ({
      ...inst,
      trading_symbol: inst.trading_symbol.toUpperCase(),
    }));

    console.log(`✅ Downloaded ${normalized.length} from ${exchange}`);
    return normalized;
  } catch (error) {
    console.error(`❌ Failed to download ${exchange}:`, error.message);
    return [];
  }
}

async function insertBatches(collection, instruments) {
  let totalInserted = 0;
  
  for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
    const batch = instruments.slice(i, i + BATCH_SIZE);
    
    try {
      await collection.insertMany(batch, { ordered: false });
      totalInserted += batch.length;
      console.log(`✅ Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${totalInserted}/${instruments.length}`);
    } catch (error) {
      console.error(`❌ Batch insert error at ${i}:`, error.message);
    }
  }
  
  return totalInserted;
}

async function clearRedisCache() {
  try {
    const redisService = require('./redisService');
    if (redisService?.redis) {
      const keys = await redisService.redis.keys('instrument:*');
      if (keys.length > 0) {
        await redisService.redis.del(...keys);
        console.log(`🗑️ Cleared ${keys.length} Redis cache entries`);
      }
    }
  } catch (error) {
    console.warn('⚠️ Redis cache clear failed (non-critical):', error.message);
  }
}

async function updateInstruments() {
  try {
    console.log('📥 Downloading instruments from Upstox...');

    // Download all exchanges in parallel
    const results = await Promise.all(EXCHANGES.map(downloadExchange));
    const allInstruments = results.flat();

    if (allInstruments.length === 0) {
      throw new Error('No instruments downloaded from any exchange');
    }

    console.log(`💾 Updating MongoDB with ${allInstruments.length} instruments...`);

    if (mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = process.env.INSTRUMENTS_COLLECTION || 'instruments';
    const collection = db.collection(collectionName);

    console.log(`🗑️ Clearing existing instruments from ${collectionName}...`);
    const deleteResult = await collection.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} old instruments`);

    const totalInserted = await insertBatches(collection, allInstruments);
    console.log(`✅ Inserted ${totalInserted} instruments into MongoDB`);

    await clearRedisCache();

    return { 
      success: true, 
      count: totalInserted,
      deleted: deleteResult.deletedCount 
    };
  } catch (error) {
    console.error('❌ Instrument update failed:', error.message);
    throw error;
  }
}

module.exports = { updateInstruments };
