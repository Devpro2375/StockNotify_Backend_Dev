// services/instrumentService.js

const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');

async function updateInstruments() {
  try {
    console.log('📥 Downloading instruments from Upstox...');

    const exchanges = ['NSE', 'BSE', 'NFO', 'MCX', 'BFO', 'CDS'];
    let allInstruments = [];

    for (const exchange of exchanges) {
      try {
        const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
        console.log(`📡 Fetching ${exchange}...`);

        // Download gzipped JSON; disable auto-decompress to manually gunzip
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'Accept-Encoding': 'gzip, deflate' },
          decompress: false,
        });

        console.log(`📦 Decompressing ${exchange}...`);
        const decompressed = gunzipSync(Buffer.from(response.data));
        const instruments = JSON.parse(decompressed.toString('utf-8'));

        const normalized = instruments.map((inst) => ({
          ...inst,
          trading_symbol: String(inst.trading_symbol || '').toUpperCase(),
        }));

        allInstruments = allInstruments.concat(normalized);
        console.log(`✅ Downloaded ${instruments.length} instruments from ${exchange}`);
      } catch (error) {
        console.error(`❌ Failed to download ${exchange}:`, error.message);
        // continue with other exchanges
      }
    }

    if (!allInstruments.length) throw new Error('No instruments downloaded from any exchange');

    console.log(`💾 Updating MongoDB with ${allInstruments.length} total instruments...`);

    // Ensure Mongo is connected
    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = process.env.INSTRUMENTS_COLLECTION || 'instruments';
    const collection = db.collection(collectionName);

    console.log(`🗑️ Clearing existing instruments from ${collectionName}...`);
    const deleteResult = await collection.deleteMany({});
    console.log(`✅ Deleted ${deleteResult.deletedCount} old instruments`);

    // Batch insert for performance
    const batchSize = 1000;
    let totalInserted = 0;

    for (let i = 0; i < allInstruments.length; i += batchSize) {
      const batch = allInstruments.slice(i, i + batchSize);
      try {
        await collection.insertMany(batch, { ordered: false });
        totalInserted += batch.length;
        console.log(
          `✅ Inserted batch ${Math.floor(i / batchSize) + 1}: ${totalInserted}/${allInstruments.length}`
        );
      } catch (error) {
        console.error(`❌ Error inserting batch at position ${i}:`, error.message);
      }
    }

    console.log(`✅ Successfully inserted ${totalInserted} instruments into MongoDB`);

    // Clear Redis cache entries (non-fatal if fails)
    try {
      const redisService = require('./redisService');
      const cleared = await redisService.deleteKeysByPattern('instrument:*');
      console.log(`🗑️ Cleared ${cleared} instrument cache entries from Redis`);
    } catch (redisError) {
      console.warn('⚠️ Could not clear Redis cache (non-critical):', redisError.message);
    }

    return {
      success: true,
      count: totalInserted,
      deleted: deleteResult.deletedCount,
    };
  } catch (error) {
    console.error('❌ Instrument update failed:', error);
    throw error;
  }
}

module.exports = { updateInstruments };
