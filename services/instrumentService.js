// services/instrumentService.js

const axios = require('axios');
const { gunzipSync } = require('zlib');
const mongoose = require('mongoose');
const logger = require('../utils/logger');

const ALLOWED_SEGMENTS = new Set(['NSE_EQ', 'BSE_EQ', 'NSE_INDEX', 'BSE_INDEX']);
const EXCHANGES = ['NSE', 'BSE'];
const COMPLETE_INSTRUMENTS_URL = 'https://assets.upstox.com/market-quote/instruments/exchange/complete.json.gz';
const DEFAULT_COLLECTION = 'instruments';
const BATCH_SIZE = 1000;
const SEARCH_BACKFILL_RETENTION_DAYS = 14;
const SENTINEL_SYMBOLS = ['INFY', 'RELIANCE', 'TCS', 'HDFCBANK', 'SBIN'];

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

function normalizeInstrument(instrument, source = 'upstox_bod') {
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
    source,
  };
}

function dedupeByInstrumentKey(instruments) {
  const byKey = new Map();

  for (const instrument of instruments) {
    byKey.set(instrument.instrument_key, instrument);
  }

  return Array.from(byKey.values());
}

function parseInstrumentPayload(data) {
  const payload = Buffer.from(data);
  let jsonBuffer = payload;

  try {
    jsonBuffer = gunzipSync(payload);
  } catch {
    // Some upstream/proxy responses may already be decompressed.
  }

  const parsed = JSON.parse(jsonBuffer.toString('utf-8'));
  if (!Array.isArray(parsed)) {
    throw new Error('Upstox instrument payload is not an array');
  }
  return parsed;
}

async function downloadInstrumentFile(url) {
  const response = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    headers: { 'Accept-Encoding': 'gzip, deflate' },
    decompress: false,
    validateStatus: () => true,
  });

  if (response.status !== 200) {
    throw new Error(`HTTP ${response.status}`);
  }

  return parseInstrumentPayload(response.data);
}

function summarizeDownloadedExchanges(instruments) {
  const exchanges = new Set();
  for (const instrument of instruments) {
    const exchange = inferExchange(instrument);
    if (EXCHANGES.includes(exchange)) exchanges.add(exchange);
  }
  return exchanges;
}

async function downloadCompleteBodInstruments() {
  const raw = await downloadInstrumentFile(COMPLETE_INSTRUMENTS_URL);
  const filtered = raw.map((instrument) => normalizeInstrument(instrument, 'upstox_bod')).filter(Boolean);
  const downloadedExchanges = summarizeDownloadedExchanges(filtered);

  logger.info(`Instrument update: complete BOD ${raw.length} total -> ${filtered.length} kept`, {
    exchanges: Array.from(downloadedExchanges),
  });

  if (downloadedExchanges.size !== EXCHANGES.length) {
    throw new Error(
      `Complete BOD missing exchange coverage (${Array.from(downloadedExchanges).join(', ') || 'none'})`
    );
  }

  return filtered;
}

async function downloadExchangeBodInstruments() {
  let allInstruments = [];
  const downloadedExchanges = new Set();

  for (const exchange of EXCHANGES) {
    const url = `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
    const raw = await downloadInstrumentFile(url);
    const filtered = raw.map((instrument) => normalizeInstrument(instrument, 'upstox_bod')).filter(Boolean);
    if (filtered.length > 0) downloadedExchanges.add(exchange);

    allInstruments = allInstruments.concat(filtered);
    logger.info(`Instrument update: ${exchange} ${raw.length} total -> ${filtered.length} kept`);
  }

  if (downloadedExchanges.size !== EXCHANGES.length) {
    throw new Error(
      `Incomplete instrument download (${Array.from(downloadedExchanges).join(', ') || 'none'}). Existing collection left unchanged.`
    );
  }

  return allInstruments;
}

async function downloadBodInstruments() {
  try {
    logger.info('Instrument update: downloading complete Upstox BOD instruments');
    return {
      source: 'complete',
      instruments: await downloadCompleteBodInstruments(),
    };
  } catch (completeError) {
    logger.warn('Instrument update: complete BOD download failed; falling back to NSE/BSE files', {
      error: completeError.message,
    });
  }

  logger.info('Instrument update: downloading NSE + BSE exchange BOD instruments');
  return {
    source: 'exchange',
    instruments: await downloadExchangeBodInstruments(),
  };
}

async function ensureInstrumentIndexes(collection) {
  await Promise.all([
    collection.createIndex({ instrument_key: 1 }, { name: 'instrument_key_asc', background: true }),
    collection.createIndex({ segment: 1 }, { name: 'segment_asc', background: true }),
    collection.createIndex({ segment: 1, trading_symbol: 1 }, { name: 'segment_ts', background: true }),
    collection.createIndex({ segment: 1, search_symbol: 1 }, { name: 'segment_search_symbol', background: true }),
    collection.createIndex({ segment: 1, search_name: 1 }, { name: 'segment_search_name', background: true }),
    collection.createIndex({ segment: 1, search_tokens: 1 }, { name: 'segment_search_tokens', background: true }),
    collection.createIndex({ source: 1 }, { name: 'source_asc', background: true }),
    collection.createIndex({ source: 1, search_backfilled_at: 1 }, { name: 'source_backfilled_at', background: true }),
    collection.createIndex({ refreshed_at: 1 }, { name: 'refreshed_at_asc', background: true }),
  ]);
}

function getSearchBackfillCutoff() {
  return new Date(Date.now() - SEARCH_BACKFILL_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

async function upsertInstruments(collection, instruments) {
  const refreshBatch = new mongoose.Types.ObjectId().toString();
  const refreshedAt = new Date();
  const backfillCutoff = getSearchBackfillCutoff();
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
            source: 'upstox_bod',
            refresh_batch: refreshBatch,
            refreshed_at: refreshedAt,
          },
          $unset: { search_backfilled_at: '' },
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
      { segment: { $nin: Array.from(ALLOWED_SEGMENTS) } },
      { source: 'upstox_search', search_backfilled_at: { $lt: backfillCutoff } },
      {
        refresh_batch: { $ne: refreshBatch },
        $or: [
          { source: { $ne: 'upstox_search' } },
          { search_backfilled_at: { $exists: false } },
          { search_backfilled_at: { $lt: backfillCutoff } },
        ],
      },
    ],
  });

  await ensureInstrumentIndexes(collection);

  return {
    refreshBatch,
    deleted: deleteResult.deletedCount,
    written: processed,
  };
}

async function collectDiagnostics(collection) {
  const allowedSegments = Array.from(ALLOWED_SEGMENTS);
  const [bySegment, byExchange, byInstrumentType] = await Promise.all([
    collection
      .aggregate([
        { $match: { segment: { $in: allowedSegments } } },
        { $group: { _id: '$segment', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    collection
      .aggregate([
        { $match: { segment: { $in: allowedSegments } } },
        { $group: { _id: '$exchange', count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    collection
      .aggregate([
        { $match: { segment: { $in: allowedSegments } } },
        { $group: { _id: '$instrument_type', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 20 },
      ])
      .toArray(),
  ]);

  return { bySegment, byExchange, byInstrumentType };
}

async function warnOnMissingSentinels(collection) {
  for (const symbol of SENTINEL_SYMBOLS) {
    const rows = await collection
      .find(
        { trading_symbol: symbol, segment: { $in: ['NSE_EQ', 'BSE_EQ'] } },
        { projection: { _id: 0, segment: 1, instrument_key: 1, name: 1 } }
      )
      .toArray();

    const segments = new Set(rows.map((row) => row.segment));
    const missing = ['NSE_EQ', 'BSE_EQ'].filter((segment) => !segments.has(segment));
    if (missing.length > 0) {
      logger.warn('Instrument update: sentinel symbol missing expected exchange coverage', {
        symbol,
        missing,
        found: rows,
      });
    }
  }
}

async function updateInstruments() {
  try {
    const downloadResult = await downloadBodInstruments();
    let allInstruments = dedupeByInstrumentKey(downloadResult.instruments);

    if (!allInstruments.length) throw new Error('No instruments downloaded from Upstox');

    if (!mongoose.connection || mongoose.connection.readyState !== 1) {
      throw new Error('MongoDB not connected');
    }

    const db = mongoose.connection.db;
    const collectionName = getCollectionName();
    const collection = db.collection(collectionName);

    const writeResult = await upsertInstruments(collection, allInstruments);
    const diagnostics = await collectDiagnostics(collection);
    await warnOnMissingSentinels(collection);

    logger.info('Instrument update diagnostics', diagnostics);

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
      source: downloadResult.source,
      diagnostics,
    };
  } catch (error) {
    logger.error('Instrument update failed', { error: error.message });
    throw error;
  }
}

module.exports = { updateInstruments };
