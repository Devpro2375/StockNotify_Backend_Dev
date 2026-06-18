// services/instrumentService.js

const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const ALLOWED_SEGMENTS = new Set(['NSE_EQ', 'BSE_EQ', 'NSE_INDEX', 'BSE_INDEX']);
const EXCHANGES = ['NSE', 'BSE'];
const DEFAULT_COLLECTION = 'instruments';
const BATCH_SIZE = 1000;

function getCollectionName() {
  return process.env.INSTRUMENTS_COLLECTION || process.env.MONGODB_COLLECTION || DEFAULT_COLLECTION;
}

function normalizeSearchValue(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function buildSearchTokens(...values) {
  const tokens = new Set();

  for (const value of values) {
    const words = String(value || '')
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((token) => token.length > 1);

    for (const word of words) tokens.add(word);

    const compact = normalizeSearchValue(value);
    if (compact.length > 1) tokens.add(compact);
  }

  return Array.from(tokens);
}

function inferExchange(instrument) {
  const segment = String(instrument.segment || '').toUpperCase();
  if (segment.startsWith('NSE_')) return 'NSE';
  if (segment.startsWith('BSE_')) return 'BSE';
  return String(instrument.exchange || '').toUpperCase();
}

function normalizeInstrument(instrument) {
  const segment = String(instrument.segment || '').toUpperCase();
  if (!ALLOWED_SEGMENTS.has(segment)) return null;

  const tradingSymbol = String(instrument.trading_symbol || '').trim().toUpperCase();
  const instrumentKey = String(instrument.instrument_key || '').trim();
  if (!tradingSymbol || !instrumentKey) return null;

  const name = String(instrument.name || '').trim();

  return {
    trading_symbol: tradingSymbol,
    instrument_key: instrumentKey,
    exchange: inferExchange({ ...instrument, segment }),
    segment,
    instrument_type: String(instrument.instrument_type || '').trim().toUpperCase(),
    name,
    search_symbol: normalizeSearchValue(tradingSymbol),
    search_name: normalizeSearchValue(name),
    search_tokens: buildSearchTokens(tradingSymbol, name),
  };
}

function dedupeByInstrumentKey(instruments) {
  const byKey = new Map();

  for (const instrument of instruments) {
    byKey.set(instrument.instrument_key, instrument);
  }

  return Array.from(byKey.values());
}

async function ensureInstrumentIndexes(collection) {
  await Promise.all([
    collection.createIndex({ instrument_key: 1 }, { name: 'instrument_key_asc', background: true }),
    collection.createIndex({ segment: 1 }, { name: 'segment_asc', background: true }),
    collection.createIndex({ segment: 1, trading_symbol: 1 }, { name: 'segment_ts', background: true }),
    collection.createIndex({ segment: 1, search_symbol: 1 }, { name: 'segment_search_symbol', background: true }),
    collection.createIndex({ segment: 1, search_name: 1 }, { name: 'segment_search_name', background: true }),
    collection.createIndex({ segment: 1, search_tokens: 1 }, { name: 'segment_search_tokens', background: true }),
    collection.createIndex({ refreshed_at: 1 }, { name: 'refreshed_at_asc', background: true }),
  ]);
}

async function upsertInstruments(collection, instruments) {
  const refreshBatch = new mongoose.Types.ObjectId().toString();
  const refreshedAt = new Date();
  let processed = 0;

  await collection.createIndex({ instrument_key: 1 }, { name: 'instrument_key_asc', background: true });

  for (let i = 0; i < instruments.length; i += BATCH_SIZE) {
    const batch = instruments.slice(i, i + BATCH_SIZE);
    const operations = batch.map((instrument) => ({
      updateOne: {
        filter: { instrument_key: instrument.instrument_key },
        update: {
          $set: {
            ...instrument,
            refresh_batch: refreshBatch,
            refreshed_at: refreshedAt,
          },
          $setOnInsert: { created_at: refreshedAt },
        },
        upsert: true,
      },
    }));

    await collection.bulkWrite(operations, { ordered: false });
    processed += batch.length;
  }

  const deleteResult = await collection.deleteMany({
    $or: [
      { refresh_batch: { $ne: refreshBatch } },
      { segment: { $nin: Array.from(ALLOWED_SEGMENTS) } },
    ],
  });

  await ensureInstrumentIndexes(collection);

  return {
    refreshBatch,
    deleted: deleteResult.deletedCount,
    written: processed,
  };
}

async function updateInstruments() {
  try {
    logger.info('Instrument update: downloading NSE + BSE (EQ + INDEX only)');

    let allInstruments = [];
    const downloadedExchanges = new Set();

    for (const exchange of EXCHANGES) {
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

        const filtered = instruments.map(normalizeInstrument).filter(Boolean);
        if (filtered.length > 0) downloadedExchanges.add(exchange);

        allInstruments = allInstruments.concat(filtered);
        logger.info(`Instrument update: ${exchange} ${instruments.length} total -> ${filtered.length} kept`);
      } catch (error) {
        logger.error(`Instrument update: failed to download ${exchange}`, { error: error.message });
      }
    }

    if (downloadedExchanges.size !== EXCHANGES.length) {
      throw new Error(
        `Incomplete instrument download (${Array.from(downloadedExchanges).join(', ') || 'none'}). Existing collection left unchanged.`
      );
    }

    if (!allInstruments.length) throw new Error('No instruments downloaded from any exchange');
    allInstruments = dedupeByInstrumentKey(allInstruments);

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = getCollectionName();
    const collection = db.collection(collectionName);

    const writeResult = await upsertInstruments(collection, allInstruments);

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
      count: allInstruments.length,
      deleted: writeResult.deleted,
      written: writeResult.written,
      collection: collectionName,
      refreshBatch: writeResult.refreshBatch,
    };
  } catch (error) {
    logger.error('Instrument update failed', { error: error.message });
    throw error;
  }
}

module.exports = { updateInstruments };
