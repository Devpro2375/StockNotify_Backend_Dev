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

// ── LTP dedup for Socket.IO broadcast ──
// Prevents emitting identical ticks to rooms when price hasn't changed
const lastBroadcastLtp = new Map();

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
  if (!allStocks.length) return;

  // Batch check which symbols need subscription using pipeline
  const toSubscribe = await redisService.filterSubscribable(allStocks);
  if (toSubscribe.length) {
    subscribe(toSubscribe);
    logger.info(`Re-subscribed to ${toSubscribe.length} symbols after reconnect`);
  }
}

async function fetchLastClose(instrumentKey) {
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
    if (!candles.length) return null;

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
    if (err.response?.status === 404) {
      logger.warn(`Symbol ${instrumentKey} not found or no data available`);
    } else if (err.response?.status === 401) {
      logger.error("Access token invalid/expired for fetchLastClose");
    } else {
      logger.error(`Error fetching last close for ${instrumentKey}`, { error: err.message });
    }
    return null;
  }
}

// ── Helper: extract LTP from decoded tick ──
function extractLtp(tick) {
  return tick?.fullFeed?.marketFF?.ltpc?.ltp ?? tick?.fullFeed?.indexFF?.ltpc?.ltp ?? null;
}

let connecting = false;

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error("Max reconnect attempts reached. Manual intervention needed.");
      connecting = false;
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
      reconnectAttempts = 0;
      connecting = false;
      resubscribeAll();
      const io = ioInstance.getIo();
      if (io) io.emit("ws-reconnected");
    });

    // ── HOT PATH — optimized for minimum latency ──
    ws.on("message", (buffer) => {
      try {
        if (!buffer) return;
        const decoded = FeedResponse.decode(buffer);
        const feeds = decoded?.feeds;
        if (!feeds) return;

        const io = ioInstance.getIo();
        const symbols = Object.keys(feeds);
        if (!symbols.length) return;

        metrics.inc("ws_ticks_received", symbols.length);

        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];
          const tick = feeds[symbol];

          // Extract LTP once
          const ltp = extractLtp(tick);
          const ltpNum = typeof ltp === "number" ? ltp : Number(ltp);

          // 1) Buffer tick for Redis (synchronous, non-blocking)
          redisService.setLastTick(symbol, tick);

          // 2) Dedup before Socket.IO broadcast — skip if LTP unchanged
          if (io && ltpNum && lastBroadcastLtp.get(symbol) !== ltpNum) {
            lastBroadcastLtp.set(symbol, ltpNum);
            // Emit full tick object for clients that need OHLC data
            io.in(symbol).emit("tick", { symbol, tick });
          }

          // 3) Process alerts directly via setImmediate (non-blocking)
          //    This replaces the Bull queue path entirely.
          if (ltpNum && !Number.isNaN(ltpNum)) {
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
      const delay = Math.min(baseDelay + jitter, 60000);
      logger.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${reconnectAttempts})`);
      setTimeout(() => connect().catch(() => {}), delay);
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
    setTimeout(() => connect().catch(() => {}), Math.min(baseDelay + jitter, 60000));
  }
}

function sendSubscription(method, symbols) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    Buffer.from(
      JSON.stringify({
        guid: "someguid",
        method,
        data: { mode: "full", instrumentKeys: symbols },
      })
    )
  );
}

function getWsStatus() {
  if (!ws) return { connected: false, status: "Not initialized" };
  const states = {
    [WebSocket.OPEN]: { connected: true, status: "Connected" },
    [WebSocket.CONNECTING]: { connected: false, status: "Connecting" },
    [WebSocket.CLOSING]: { connected: false, status: "Closing" },
    [WebSocket.CLOSED]: { connected: false, status: "Disconnected" },
  };
  return states[ws.readyState] || { connected: false, status: "Unknown" };
}

const subscribe = (symbols) => sendSubscription("sub", symbols);
const unsubscribe = (symbols) => sendSubscription("unsub", symbols);

module.exports = {
  subscribe,
  unsubscribe,
  fetchLastClose,
  connect,
  getWsStatus,
};
