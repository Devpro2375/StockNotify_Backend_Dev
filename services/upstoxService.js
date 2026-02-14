// services/upstoxService.js

const WebSocket = require("ws");
const axios = require("axios");

const config = require("../config/config");
const ioInstance = require("./ioInstance");
const redisService = require("./redisService");
const AccessToken = require("../models/AccessToken");
const alertQueue = require("../queues/alertQueue");

// Protobuf loader (robust fallback path resolution)
const protoRoot = require("../proto/marketdata.js");
let FeedResponse;
try {
  FeedResponse =
    protoRoot.com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse ||
    protoRoot.com.upstox.marketdatafeederv3udapi.proto.FeedResponse ||
    protoRoot.upstox.proto.FeedResponse ||
    protoRoot.FeedResponse;
} catch (e) {
  // noop; checked below
}
if (!FeedResponse || typeof FeedResponse.decode !== "function") {
  console.error("Failed to load FeedResponse from compiled proto.");
  throw new Error(
    "Invalid compiled proto. Verify build step and package path."
  );
}
console.log("FeedResponse loaded successfully with decode method.");

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

async function getAccessTokenFromDB() {
  const tokenDoc = await AccessToken.findOne().lean();
  if (!tokenDoc || !tokenDoc.token) {
    throw new Error(
      "No access token found in database. Please update via admin dashboard."
    );
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
    if (!url)
      throw new Error("Invalid Upstox WS auth response (no redirect URI)");
    console.log("Fetched fresh authorized URL for Upstox WS");
    return url;
  } catch (err) {
    console.error("Failed to fetch authorized URL:", err.message);
    if (err.response?.status === 401) {
      console.error("Access token expired! Regenerate it.");
    }
    throw err;
  }
}

async function resubscribeAll() {
  const [globalStocks, persistentStocks] = await Promise.all([
    redisService.getAllGlobalStocks(),
    redisService.getPersistentStocks(),
  ]);
  const allStocks = [...new Set([...globalStocks, ...persistentStocks])];

  // Batch subscribe check — collect symbols that need subscription
  const toSubscribe = [];
  for (const symbol of allStocks) {
    if (await redisService.shouldSubscribe(symbol)) {
      toSubscribe.push(symbol);
    }
  }
  if (toSubscribe.length) {
    subscribe(toSubscribe);
    console.log(`🔄 Re-subscribed to ${toSubscribe.length} symbols`);
  }
}

async function fetchLastClose(instrumentKey) {
  try {
    const accessToken = await getAccessTokenFromDB();
    const baseUrl =
      config.upstoxBaseUrl || config.upstoxRestUrl || "https://api.upstox.com";
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
      console.warn(`Symbol ${instrumentKey} not found or no data available.`);
    } else if (err.response?.status === 401) {
      console.error("Access token invalid/expired. Regenerate.");
    } else {
      console.error(
        `Error fetching last close for ${instrumentKey}:`,
        err.message
      );
    }
    return null;
  }
}

let connecting = false;

async function connect() {
  if (connecting) return;
  connecting = true;

  try {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error(
        "Max reconnect attempts reached. Manual intervention needed."
      );
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
      console.log("Connected to Upstox WS");
      reconnectAttempts = 0;
      resubscribeAll();
      const io = ioInstance.getIo();
      if (io) io.emit("ws-reconnected");
      connecting = false;
    });

    // ── HOT PATH — optimized for minimum latency ──
    ws.on("message", (buffer) => {
      try {
        if (!buffer) return;
        const decoded = FeedResponse.decode(buffer);
        const feeds = decoded?.feeds;
        if (!feeds) return;

        const io = ioInstance.getIo();
        if (!io || typeof io.in !== "function") return;

        const symbols = Object.keys(feeds);
        if (!symbols.length) return;

        // 1) Emit to Socket.IO rooms FIRST — this is non-blocking and
        //    gets data to connected clients with minimal latency.
        // 2) Fire Redis cache + alert queue in parallel without awaiting
        //    to keep the event loop free for the next WS message.
        const promises = [];
        for (let i = 0; i < symbols.length; i++) {
          const symbol = symbols[i];
          const tick = feeds[symbol];

          // Instant emit — synchronous, non-blocking
          io.in(symbol).emit("tick", { symbol, tick });

          // Async: cache tick + queue alert check (fire-and-forget)
          promises.push(
            redisService.setLastTick(symbol, tick),
            alertQueue.add({ symbol, tick }, { priority: 2 })
          );
        }

        // Don't await — let these resolve in the background
        Promise.all(promises).catch((err) =>
          console.error("Tick batch error:", err.message)
        );
      } catch (decodeErr) {
        console.error("Failed to decode WS message:", decodeErr.message);
        if (decodeErr.message.includes("OOM")) {
          redisService.cleanupStaleStocks().catch(() => { });
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`WS closed: Code ${code}, Reason: ${reason}`);
      reconnectAttempts++;
      const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
      console.log(
        `Reconnecting in ${Math.min(
          delay / 1000,
          60
        )} seconds (Attempt ${reconnectAttempts})...`
      );
      setTimeout(() => connect().catch(() => { }), Math.min(delay, 60000));
    });

    ws.on("error", (err) => {
      console.error("WS error:", err.message);
      if (ws) ws.close();
    });
  } catch (err) {
    console.error("Connect failed:", err.message);
    reconnectAttempts++;
    const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
    setTimeout(() => connect().catch(() => { }), Math.min(delay, 60000));
  } finally {
    connecting = false;
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
  switch (ws.readyState) {
    case WebSocket.OPEN:
      return { connected: true, status: "Connected" };
    case WebSocket.CONNECTING:
      return { connected: false, status: "Connecting" };
    case WebSocket.CLOSING:
      return { connected: false, status: "Closing" };
    case WebSocket.CLOSED:
      return { connected: false, status: "Disconnected" };
    default:
      return { connected: false, status: "Unknown" };
  }
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
