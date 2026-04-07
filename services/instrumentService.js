// services/instrumentService.js

const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');
const logger = require('../utils/logger');

// Only NSE and BSE equity + index segments
const ALLOWED_SEGMENTS = new Set(['NSE_EQ', 'BSE_EQ', 'NSE_INDEX', 'BSE_INDEX']);

async function updateInstruments() {
  try {
    logger.info('Instrument update: downloading NSE + BSE (EQ + INDEX only)');

    const exchanges = ['NSE', 'BSE'];
    let allInstruments = [];

    for (const exchange of exchanges) {
      try {
        const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
        const response = await axios.get(url, {
          responseType: 'arraybuffer',
          timeout: 30000,
          headers: { 'Accept-Encoding': 'gzip, deflate' },
          decompress: false,
        });

        const decompressed = gunzipSync(Buffer.from(response.data));
        const instruments = JSON.parse(decompressed.toString('utf-8'));

        const filtered = instruments
          .filter((inst) => ALLOWED_SEGMENTS.has(inst.segment))
          .map((inst) => ({
            trading_symbol: String(inst.trading_symbol || '').toUpperCase(),
            instrument_key: String(inst.instrument_key || ''),
            exchange: String(inst.exchange || ''),
            segment: String(inst.segment || ''),
            instrument_type: String(inst.instrument_type || ''),
            name: String(inst.name || ''),
          }));

        allInstruments = allInstruments.concat(filtered);
        logger.info(`Instrument update: ${exchange} ${instruments.length} total → ${filtered.length} kept`);
      } catch (error) {
        logger.error(`Instrument update: failed to download ${exchange}`, { error: error.message });
      }
    }

    if (!allInstruments.length) throw new Error('No instruments downloaded from any exchange');

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = process.env.INSTRUMENTS_COLLECTION || 'instruments';
    const collection = db.collection(collectionName);

    const deleteResult = await collection.deleteMany({});
    // Drop all non-_id indexes so stale/renamed indexes don't accumulate
    await collection.dropIndexes();

    const batchSize = 1000;
    let totalInserted = 0;
    for (let i = 0; i < allInstruments.length; i += batchSize) {
      const batch = allInstruments.slice(i, i + batchSize);
      try {
        await collection.insertMany(batch, { ordered: false });
        totalInserted += batch.length;
      } catch (error) {
        logger.error(`Instrument update: batch insert error at ${i}`, { error: error.message });
      }
    }

    // Rebuild indexes after insert (dropIndexes above cleared old ones)
    await Promise.all([
      collection.createIndex({ trading_symbol: 1 }, { name: 'ts_asc' }),
      collection.createIndex({ segment: 1 }, { name: 'segment_asc' }),
      collection.createIndex({ trading_symbol: 1, segment: 1 }, { name: 'ts_segment' }),
      collection.createIndex({ name: 1 }, { name: 'name_asc' }),
    ]);

    // Clear all search-related Redis cache (non-fatal)
    try {
      const redisService = require('./redisService');
      await Promise.all([
        redisService.deleteKeysByPattern('search:*'),
        redisService.deleteKeysByPattern('chart-search:*'),
        redisService.deleteKeysByPattern('instrument:*'),
      ]);
      logger.info('Instrument update: Redis search cache cleared');
    } catch (redisError) {
      logger.warn('Instrument update: Redis cache clear failed (non-critical)', { error: redisError.message });
    }

    return {
      success: true,
      count: totalInserted,
      deleted: deleteResult.deletedCount,
    };
  } catch (error) {
    logger.error('Instrument update failed', { error: error.message });
    throw error;
  }
}

module.exports = { updateInstruments };
