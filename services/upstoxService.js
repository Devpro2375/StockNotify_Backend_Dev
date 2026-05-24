// services/upstoxService.js
// ──────────────────────────────────────────────────────────────
// REFACTORED: Optimized tick hot path
//  1. Extract LTP ONCE per symbol at decode time
//  2. Dedup unchanged LTP before broadcast (saves Socket.IO bandwidth)
//  3. Call alertService.processTickAlerts() via setImmediate() instead
//     of Bull queue — eliminates Redis serialize/deserialize roundtrip
//  4. Batch resubscribe with pipelined shouldSubscribe checks
//  5. Added jitter to reconnect backoff to prevent thundering herd
// ──────────────────────────────────────────────────────────────

const WebSocket = require("ws");
const axios = require("axios");

const config = require("../config/config");
const ioInstance = require("./ioInstance");
const redisService = require("./redisService");
const AccessToken = require("../models/AccessToken");
const logger = require("../utils/logger");
const metrics = require("../utils/metrics");

// Lazy-load alertService to avoid circular dependency at module load
let _alertService = null;
function getAlertService() {
  if (!_alertService) _alertService = require("./alertService");
  return _alertService;
}

// Protobuf loader
const protoRoot = require("../proto/marketdata.js");
let FeedResponse;
try {
  FeedResponse =
    protoRoot.com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse ||
    protoRoot.com.upstox.marketdatafeederv3udapi.proto.FeedResponse ||
    protoRoot.upstox.proto.FeedResponse ||
    protoRoot.FeedResponse;
} catch (e) {
  // checked below
}
if (!FeedResponse || typeof FeedResponse.decode !== "function") {
  logger.error("Failed to load FeedResponse from compiled proto.");
  throw new Error("Invalid compiled proto. Verify build step and package path.");
}
logger.info("FeedResponse loaded successfully");

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const MAX_RECONNECT_DELAY = 5 * 60 * 1000;
const SUBSCRIPTION_BATCH_SIZE = Number(process.env.UPSTOX_WS_SUBSCRIPTION_BATCH_SIZE || 100);
const FEED_HEALTH_CHECK_MS = Number(process.env.UPSTOX_WS_HEALTH_CHECK_MS || 30_000);
const FEED_STALE_MS = Number(process.env.UPSTOX_WS_STALE_MS || 90_000);
const FEED_STALE_ACTION_COOLDOWN_MS = Number(process.env.UPSTOX_WS_STALE_ACTION_COOLDOWN_MS || 60_000);
const LTP_FALLBACK_POLL_MS = Number(process.env.UPSTOX_LTP_FALLBACK_POLL_MS || 10_000);
const LTP_FALLBACK_BATCH_SIZE = Number(process.env.UPSTOX_LTP_FALLBACK_BATCH_SIZE || 50);

// ── LTP dedup for Socket.IO broadcast ──
// Prevents emitting identical ticks to rooms when price hasn't changed
const lastBroadcastLtp = new Map();

const desiredSubscriptions = new Set();
let connectedAt = 0;
let lastMessageAt = 0;
let lastTickAt = 0;
let lastSubscriptionAt = 0;
let lastStaleActionAt = 0;
let staleRecoveryAttempts = 0;
let reconnectTimer = null;
let feedHealthTimer = null;
let ltpFallbackTimer = null;
let ltpFallbackInFlight = false;
let lastFallbackQuoteAt = 0;
let lastFallbackLogAt = 0;

// ── Failed symbol cooldown cache ──
// Tracks symbols that fail fetchLastClose repeatedly. Skips them for 30 min.
const failedSymbolCache = new Map(); // symbol -> { count, lastFailAt }
const FAIL_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const FAIL_THRESHOLD = 3; // skip after this many consecutive failures

async function getAccessTokenFromDB() {
  const tokenDoc = await AccessToken.findOne().lean();
  if (!tokenDoc || !tokenDoc.token) {
    throw new Error("No access token found in database. Please update via admin dashboard.");
  }
  return tokenDoc.token;
}

async function getAuthorizedUrl() {
  try {
    const accessToken = await getAccessTokenFromDB();
    const res = await axios.get(config.upstoxWsAuthUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });
    const url = res.data?.data?.authorized_redirect_uri;
    if (!url) throw new Error("Invalid Upstox WS auth response (no redirect URI)");
    logger.info("Fetched authorized URL for Upstox WS");
    return url;
  } catch (err) {
    logger.error("Failed to fetch authorized URL", { error: err.message, status: err.response?.status });
    throw err;
  }
}

async function resubscribeAll() {
  const [globalStocks, persistentStocks] = await Promise.all([
    redisService.getAllGlobalStocks(),
    redisService.getPersistentStocks(),
  ]);
  const allStocks = [...new Set([...globalStocks, ...persistentStocks])];
  if (!allStocks.length) {
    desiredSubscriptions.clear();
    metrics.gauge("ws_subscribed_symbols", 0);
    return;
  }

  // Batch check which symbols need subscription using pipeline
  const toSubscribe = await redisService.filterSubscribable(allStocks);
  desiredSubscriptions.clear();
  for (const symbol of toSubscribe) desiredSubscriptions.add(symbol);
  metrics.gauge("ws_subscribed_symbols", desiredSubscriptions.size);

  if (toSubscribe.length) {
    sendSubscription("sub", toSubscribe);
    logger.info(`Re-subscribed to ${toSubscribe.length} symbols after reconnect`, {
      batches: Math.ceil(toSubscribe.length / SUBSCRIPTION_BATCH_SIZE),
    });
  }
}

async function fetchLastClose(instrumentKey) {
  // Check cooldown: skip symbols that fail repeatedly
  const failInfo = failedSymbolCache.get(instrumentKey);
  if (failInfo && failInfo.count >= FAIL_THRESHOLD) {
    if (Date.now() - failInfo.lastFailAt < FAIL_COOLDOWN_MS) {
      return null; // still in cooldown
    }
    failedSymbolCache.delete(instrumentKey); // cooldown expired, retry
  }

  try {
    const accessToken = await getAccessTokenFromDB();
    const baseUrl = config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
    const encodedKey = encodeURIComponent(instrumentKey);
    const today = new Date().toISOString().slice(0, 10);
    const url = `${baseUrl}/v3/historical-candle/${encodedKey}/days/1/${today}/${today}`;

    const res = await axios.get(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000,
    });

    const candles = res.data?.data?.candles || [];
    if (!candles.length) {
      // Track failure
      const info = failedSymbolCache.get(instrumentKey) || { count: 0, lastFailAt: 0 };
      info.count++;
      info.lastFailAt = Date.now();
      failedSymbolCache.set(instrumentKey, info);
      return null;
    }

    // Success — clear failure history
    failedSymbolCache.delete(instrumentKey);

    const last = candles[candles.length - 1];
    const payload = {
      timestamp: last[0],
      open: last[1],
      high: last[2],
      low: last[3],
      close: last[4],
      volume: last[5],
    };

    await redisService.setLastClosePrice(instrumentKey, payload);
    return payload;
  } catch (err) {
    // Track failure
    const info = failedSymbolCache.get(instrumentKey) || { count: 0, lastFailAt: 0 };
    info.count++;
    info.lastFailAt = Date.now();
    failedSymbolCache.set(instrumentKey, info);

    if (err.response?.status === 429) {
      const retryAfter = err.response.headers?.['retry-after'] || 60;
      logger.warn(`Rate limited on fetchLastClose, retry after ${retryAfter}s`);
    } else if (err.response?.status === 404) {
      // Only warn once, then cooldown handles suppression
      if (info.count <= 1) {
        logger.warn(`Symbol ${instrumentKey} not found or no data available`);
      }
    } else if (err.response?.status === 401) {
      logger.error("Access token invalid/expired for fetchLastClose");
    } else {
      if (info.count <= 1) {
        logger.warn(`Error fetching last close for ${instrumentKey}`, { error: err.message });
      }
    }
    return null;
  }
}

// ── Helper: extract LTP from decoded tick ──
function extractLtp(tick) {
  return (
    tick?.fullFeed?.marketFF?.ltpc?.ltp ??
    tick?.fullFeed?.indexFF?.ltpc?.ltp ??
    tick?.ltpc?.ltp ??
    tick?.firstLevelWithGreeks?.ltpc?.ltp ??
    null
  );
}

function annotateTick(tick, source, receivedAt = Date.now()) {
  if (tick && typeof tick === "object") {
    tick.__source = source;
    tick.__receivedAt = receivedAt;
  }
  return tick;
}

function findQuotePayload(data, instrumentKey) {
  if (!data || typeof data !== "object") return null;
  if (data[instrumentKey]) return data[instrumentKey];

  return Object.values(data).find((quote) => {
    const token = quote?.instrument_token || quote?.instrumentToken;
    return token === instrumentKey;
  }) || null;
}

function buildFallbackOhlc(price, closePrice = price) {
  return {
    open: closePrice,
    high: price,
    low: price,
    close: price,
  };
}

function normalizeQuotePayload(payload) {
  if (!payload) return null;

  const price = Number(payload.last_price ?? payload.lastPrice ?? payload.ltp);
  if (!Number.isFinite(price)) return null;

  const closePrice = Number(payload.cp ?? payload.close ?? price);
  return {
    last_price: price,
    ohlc: buildFallbackOhlc(price, Number.isFinite(closePrice) ? closePrice : price),
    ltq: payload.ltq ?? null,
    volume: payload.volume ?? null,
    cp: Number.isFinite(closePrice) ? closePrice : null,
    source: "upstox_ltp_v3",
  };
}

function buildLtpTick(quote, receivedAt = Date.now()) {
  const ltp = Number(quote.last_price);
  const cp = Number.isFinite(Number(quote.cp)) ? Number(quote.cp) : ltp;
  const ltpc = {
    ltp,
    cp,
    ...(quote.ltq != null ? { ltq: Number(quote.ltq) } : {}),
    ltt: receivedAt,
  };

  return annotateTick(
    {
      ltpc,
      fullFeed: {
        marketFF: {
          ltpc,
        },
      },
    },
    quote.source || "upstox_ltp_v3",
    receivedAt
  );
}

async function fetchLtpQuotes(instruments) {
  const instrumentList = normalizeSymbols(instruments);
  const quotes = {};
  if (!instrumentList.length) return quotes;

  const accessToken = await getAccessTokenFromDB();
  const baseUrl = config.upstoxRestUrl || "https://api.upstox.com";

  for (const batch of chunkSymbolsWithSize(instrumentList, LTP_FALLBACK_BATCH_SIZE)) {
    const url = `${baseUrl}/v3/market-quote/ltp?instrument_key=${batch
      .map((instrument) => encodeURIComponent(instrument))
      .join(",")}`;

    try {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        timeout: 5000,
      });

      const data = response.data?.data || {};
      for (const instrument of batch) {
        const quote = normalizeQuotePayload(findQuotePayload(data, instrument));
        if (quote) quotes[instrument] = quote;
      }
    } catch (err) {
      logger.warn("Upstox LTP fallback batch failed", {
        count: batch.length,
        status: err.response?.status,
        error: err.message,
      });
    }
  }

  return quotes;
}

let connecting = false;

function normalizeSymbols(symbols) {
  const list = Array.isArray(symbols) ? symbols : [symbols];
  return [...new Set(list.map((s) => String(s || "").trim()).filter(Boolean))];
}

function chunkSymbols(symbols) {
  return chunkSymbolsWithSize(symbols, SUBSCRIPTION_BATCH_SIZE);
}

function chunkSymbolsWithSize(symbols, size) {
  const chunks = [];
  const chunkSize = Math.max(1, Number(size) || SUBSCRIPTION_BATCH_SIZE);
  for (let i = 0; i < symbols.length; i += chunkSize) {
    chunks.push(symbols.slice(i, i + chunkSize));
  }
  return chunks;
}

function makeGuid(method) {
  return `${method}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function isWsOpen() {
  return ws && ws.readyState === WebSocket.OPEN;
}

function scheduleReconnect(delay, reason) {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(() => { });
  }, delay);
  reconnectTimer.unref();

  logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s`, {
    attempt: reconnectAttempts,
    reason,
  });
}

function isLikelyIndianMarketSession(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  const day = ist.getUTCDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return minutes >= 9 * 60 + 10 && minutes <= 15 * 60 + 45;
}

function startFeedHealthMonitor() {
  if (!feedHealthTimer) {
    feedHealthTimer = setInterval(checkFeedHealth, FEED_HEALTH_CHECK_MS);
    feedHealthTimer.unref();
  }
  if (!ltpFallbackTimer) {
    ltpFallbackTimer = setInterval(pollLtpFallbackIfStale, LTP_FALLBACK_POLL_MS);
    ltpFallbackTimer.unref();
  }
}

async function checkFeedHealth() {
  if (!isWsOpen() || desiredSubscriptions.size === 0) return;
  if (!isLikelyIndianMarketSession()) return;

  const now = Date.now();
  // Subscription replays are recovery attempts, not proof that market data is flowing.
  // Base staleness on the last valid LTP tick so an open-but-silent socket reconnects.
  const referenceAt = getFeedReferenceAt();
  if (!referenceAt) return;

  const staleForMs = now - referenceAt;
  metrics.gauge("ws_last_tick_age_ms", staleForMs);

  if (staleForMs < FEED_STALE_MS) {
    return;
  }
  if (now - lastStaleActionAt < FEED_STALE_ACTION_COOLDOWN_MS) return;

  lastStaleActionAt = now;
  staleRecoveryAttempts += 1;

  const subscribedSymbols = [...desiredSubscriptions];
  if (staleRecoveryAttempts >= 2) {
    logger.warn("Upstox WS feed stale after resubscribe; forcing reconnect", {
      subscribedCount: subscribedSymbols.length,
      staleForMs,
      lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
      lastSubscriptionAt: lastSubscriptionAt ? new Date(lastSubscriptionAt).toISOString() : null,
    });
    await reconnect();
    return;
  }

  logger.warn("Upstox WS feed stale; replaying subscriptions", {
    subscribedCount: subscribedSymbols.length,
    staleForMs,
    batches: Math.ceil(subscribedSymbols.length / SUBSCRIPTION_BATCH_SIZE),
  });
  sendSubscription("sub", subscribedSymbols);
}

function getFeedReferenceAt() {
  return lastTickAt || connectedAt || 0;
}

function isFeedStale(now = Date.now()) {
  const referenceAt = getFeedReferenceAt();
  return Boolean(referenceAt && now - referenceAt >= FEED_STALE_MS);
}

async function pollLtpFallbackIfStale() {
  if (ltpFallbackInFlight) return;
  if (!isWsOpen() || desiredSubscriptions.size === 0) return;
  if (!isLikelyIndianMarketSession()) return;
  if (!isFeedStale()) return;

  ltpFallbackInFlight = true;
  const symbols = [...desiredSubscriptions];
  const startedAt = Date.now();

  try {
    const quotes = await fetchLtpQuotes(symbols);
    const io = ioInstance.getIo();
    let publishedCount = 0;

    for (const symbol of symbols) {
      const quote = quotes[symbol];
      if (!quote) continue;

      const ltpNum = Number(quote.last_price);
      if (!Number.isFinite(ltpNum)) continue;

      const receivedAt = Date.now();
      const tick = buildLtpTick(quote, receivedAt);
      redisService.setLastTick(symbol, tick);

      if (io && lastBroadcastLtp.get(symbol) !== ltpNum) {
        lastBroadcastLtp.set(symbol, ltpNum);
        io.in(symbol).emit("tick", { symbol, tick });
      }

      setImmediate(() => {
        getAlertService().processTickAlerts(symbol, ltpNum).catch((err) =>
          logger.error("Alert processing error", { symbol, error: err.message })
        );
      });

      publishedCount += 1;
    }

    if (publishedCount) {
      const completedAt = Date.now();
      lastFallbackQuoteAt = completedAt;
      metrics.inc("ltp_fallback_ticks", publishedCount);
      metrics.observe("ltp_fallback_latency_ms", completedAt - startedAt);
      if (completedAt - lastFallbackLogAt >= 60_000) {
        lastFallbackLogAt = completedAt;
        logger.warn("Published LTP fallback ticks while Upstox WS feed is stale", {
          count: publishedCount,
          subscribedCount: symbols.length,
        });
      }
    }
  } catch (err) {
    logger.warn("LTP fallback polling failed", { error: err.message });
  } finally {
    ltpFallbackInFlight = false;
  }
}

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnect attempts reached. Backing off before retry.");
      connecting = false;
      reconnectAttempts = 0;
      scheduleReconnect(MAX_RECONNECT_DELAY, "max_attempts_backoff");
      return;
    }

    const url = await getAuthorizedUrl();

    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close(1000, "Reconnecting");
        await new Promise((r) => setTimeout(r, 2000));
      } catch {
        // ignore
      }
    }

    ws = new WebSocket(url, { followRedirects: true });

    ws.on("open", () => {
      logger.info("Connected to Upstox WS");
      connectedAt = Date.now();
      lastMessageAt = 0;
      lastTickAt = 0;
      lastSubscriptionAt = 0;
      lastStaleActionAt = 0;
      staleRecoveryAttempts = 0;
      reconnectAttempts = 0;
      connecting = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      resubscribeAll().catch((err) => {
        logger.error("Upstox WS resubscribe failed", { error: err.message });
      });
      startFeedHealthMonitor();
      const io = ioInstance.getIo();
      if (io) io.emit("ws-reconnected");
    });

    // ── HOT PATH — optimized for minimum latency ──
    ws.on("message", (buffer) => {
      try {
        if (!buffer) return;
        const receivedAt = Date.now();
        lastMessageAt = receivedAt;
        metrics.inc("ws_messages_received");
        const decoded = FeedResponse.decode(buffer);
        const feeds = decoded?.feeds;
        if (!feeds) return;

        const io = ioInstance.getIo();
        const symbols = Object.keys(feeds);
        if (!symbols.length) return;

        metrics.inc("ws_ticks_received", symbols.length);

        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];
          const tick = annotateTick(feeds[symbol], "upstox_ws", receivedAt);

          // Extract LTP once
          const ltp = extractLtp(tick);
          const ltpNum = typeof ltp === "number" ? ltp : Number(ltp);
          const hasValidLtp = Number.isFinite(ltpNum) && ltp != null;

          // 1) Buffer tick for Redis (synchronous, non-blocking)
          redisService.setLastTick(symbol, tick);
          if (hasValidLtp) {
            lastTickAt = receivedAt;
            staleRecoveryAttempts = 0;
          }

          // 2) Dedup before Socket.IO broadcast — skip if LTP unchanged
          if (io && hasValidLtp && lastBroadcastLtp.get(symbol) !== ltpNum) {
            lastBroadcastLtp.set(symbol, ltpNum);
            // Emit full tick object for clients that need OHLC data
            io.in(symbol).emit("tick", { symbol, tick });
          }

          // 3) Process alerts directly via setImmediate (non-blocking)
          //    This replaces the Bull queue path entirely.
          if (hasValidLtp) {
            setImmediate(() => {
              getAlertService().processTickAlerts(symbol, ltpNum).catch((err) =>
                logger.error("Alert processing error", { symbol, error: err.message })
              );
            });
          }
        }
      } catch (decodeErr) {
        logger.error("Failed to decode WS message", { error: decodeErr.message });
      }
    });

    ws.on("close", (code, reason) => {
      logger.warn(`WS closed: Code ${code}, Reason: ${reason}`);
      connecting = false;
      reconnectAttempts++;
      // Exponential backoff with jitter to prevent thundering herd
      const baseDelay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
      const jitter = Math.random() * 2000;
      const delay = Math.min(baseDelay + jitter, MAX_RECONNECT_DELAY);
      scheduleReconnect(delay, `close_${code}`);
    });

    ws.on("error", (err) => {
      logger.error("WS error", { error: err.message });
      if (ws) ws.close();
    });
  } catch (err) {
    logger.error("Connect failed", { error: err.message });
    connecting = false;
    reconnectAttempts++;
    const baseDelay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
    const jitter = Math.random() * 2000;
    scheduleReconnect(Math.min(baseDelay + jitter, MAX_RECONNECT_DELAY), "connect_failed");
  }
}

function sendSubscription(method, symbols) {
  const normalized = normalizeSymbols(symbols);
  if (!normalized.length) return false;

  if (!isWsOpen()) {
    logger.debug("Upstox WS not open; subscription change will replay later", {
      method,
      count: normalized.length,
      status: getWsStatus().status,
    });
    return false;
  }

  const batches = chunkSymbols(normalized);
  for (const batch of batches) {
    try {
      ws.send(
        Buffer.from(
          JSON.stringify({
            guid: makeGuid(method),
            method,
            data: { mode: "full", instrumentKeys: batch },
          })
        )
      );
    } catch (err) {
      logger.error("Upstox WS subscription send failed", {
        method,
        count: batch.length,
        error: err.message,
      });
      return false;
    }
  }

  lastSubscriptionAt = Date.now();
  metrics.inc(method === "unsub" ? "ws_unsubscription_batches" : "ws_subscription_batches", batches.length);
  metrics.gauge("ws_subscribed_symbols", desiredSubscriptions.size);
  logger.info(`Upstox WS ${method} sent`, {
    count: normalized.length,
    batches: batches.length,
  });
  return true;
}

function getWsStatus() {
  if (!ws) return { connected: false, status: "Not initialized" };
  const states = {
    [WebSocket.OPEN]: { connected: true, status: "Connected" },
    [WebSocket.CONNECTING]: { connected: false, status: "Connecting" },
    [WebSocket.CLOSING]: { connected: false, status: "Closing" },
    [WebSocket.CLOSED]: { connected: false, status: "Disconnected" },
  };
  const state = states[ws.readyState] || { connected: false, status: "Unknown" };
  const now = Date.now();
  return {
    ...state,
    subscribedCount: desiredSubscriptions.size,
    connectedAt: connectedAt ? new Date(connectedAt).toISOString() : null,
    lastMessageAt: lastMessageAt ? new Date(lastMessageAt).toISOString() : null,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
    lastSubscriptionAt: lastSubscriptionAt ? new Date(lastSubscriptionAt).toISOString() : null,
    lastFallbackQuoteAt: lastFallbackQuoteAt ? new Date(lastFallbackQuoteAt).toISOString() : null,
    lastTickAgeMs: lastTickAt ? now - lastTickAt : null,
    lastFallbackQuoteAgeMs: lastFallbackQuoteAt ? now - lastFallbackQuoteAt : null,
    reconnectAttempts,
    connecting,
  };
}

const subscribe = (symbols) => {
  const normalized = normalizeSymbols(symbols);
  const toAdd = normalized.filter((symbol) => !desiredSubscriptions.has(symbol));
  for (const symbol of toAdd) desiredSubscriptions.add(symbol);
  metrics.gauge("ws_subscribed_symbols", desiredSubscriptions.size);
  return sendSubscription("sub", toAdd);
};

const unsubscribe = (symbols) => {
  const normalized = normalizeSymbols(symbols);
  for (const symbol of normalized) {
    desiredSubscriptions.delete(symbol);
    lastBroadcastLtp.delete(symbol);
  }
  metrics.gauge("ws_subscribed_symbols", desiredSubscriptions.size);
  return sendSubscription("unsub", normalized);
};

// ── Force reconnect with fresh token ──
// Called after token refresh cron to pick up the new access token
async function reconnect() {
  logger.info("Reconnecting Upstox WS with new token...");
  reconnectAttempts = 0;
  connecting = false;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    try {
      ws.close(1000, "Token refreshed — reconnecting");
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  await connect();
}

module.exports = {
  subscribe,
  unsubscribe,
  fetchLastClose,
  fetchLtpQuotes,
  connect,
  getWsStatus,
  reconnect,
};
