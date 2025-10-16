const WebSocket = require("ws");
const axios = require("axios");
const config = require("../config/config");
const ioInstance = require("./ioInstance");
const redisService = require("./redisService");
const Bull = require('bull');
const AccessToken = require("../models/AccessToken"); // NEW: Import model

// Load Protobuf (unchanged)
const protoRoot = require("../proto/marketdata.js");
let FeedResponse;
try {
  FeedResponse = protoRoot.com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse;
  console.log("Loaded FeedResponse using exact package path (v3udapi)");
} catch (e) {
  try {
    FeedResponse = protoRoot.com.upstox.marketdatafeederv3udapi.proto.FeedResponse;
    console.log("Loaded FeedResponse using shorter v3udapi path");
  } catch (e) {
    try {
      FeedResponse = protoRoot.upstox.proto.FeedResponse;
      console.log("Loaded FeedResponse using upstox.proto path");
    } catch (e) {
      try {
        FeedResponse = protoRoot.FeedResponse;
        console.log("Loaded FeedResponse using flattened path");
      } catch (e) {
        console.error(
          "Failed to load FeedResponse. protoRoot structure:",
          JSON.stringify(protoRoot, null, 2)
        );
        throw new Error(
          "Failed to load FeedResponse from compiled proto. Verify compilation and proto package."
        );
      }
    }
  }
}
if (!FeedResponse || typeof FeedResponse.decode !== "function") {
  throw new Error(
    "FeedResponse loaded but invalid (missing decode method). Check proto compilation."
  );
}
console.log("FeedResponse loaded successfully with decode method.");

// NEW: Alert queue reference (assuming alertQueue is in alertService, but add to message handler)
const alertQueue = new Bull('alert-processing', {
  redis: { host: config.redisHost, port: config.redisPort, password: config.redisPassword }
});

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

async function getAccessTokenFromDB() {
  const tokenDoc = await AccessToken.findOne();
  if (!tokenDoc || !tokenDoc.token) {
    throw new Error("No access token found in database. Please update via admin dashboard.");
  }
  return tokenDoc.token;
}

async function getAuthorizedUrl() {
  try {
    const accessToken = await getAccessTokenFromDB(); // NEW: Fetch from DB
    const res = await axios.get(config.upstoxWsAuthUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.data?.data?.authorized_redirect_uri) {
      throw new Error("Invalid Upstox auth response");
    }
    console.log("Fetched fresh authorized URL");
    return res.data.data.authorized_redirect_uri;
  } catch (err) {
    console.error("Failed to fetch authorized URL:", err.message);
    if (err.response?.status === 401) {
      console.error("Access token expired! Regenerate it.");
    }
    throw err;
  }
}

async function resubscribeAll() {
  const globalStocks = await redisService.getAllGlobalStocks();
  const persistentStocks = await redisService.getPersistentStocks();
  const allStocks = [...new Set([...globalStocks, ...persistentStocks])];
  for (const symbol of allStocks) {
    if (await redisService.shouldSubscribe(symbol)) {
      exports.subscribe([symbol]);
    }
  }
}

async function fetchLastClose(instrumentKey) {
  try {
    const accessToken = await getAccessTokenFromDB(); // NEW: Fetch from DB
    const today = new Date().toISOString().slice(0, 10);
    const res = await axios.get(
      // `${config.upstoxRestUrl}/historical/v3/${instrumentKey}/days/1`,
      {
        params: { to_date: today },
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );
    const candles = res.data.data.candles;
    if (!candles.length) {
      // console.warn(`No historical data for ${instrumentKey} on ${today}`);
      return null;
    }
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
    // console.error(`Error fetching historical for ${instrumentKey}:`, err.message);
    if (err.response?.status === 404) {
      console.warn("Symbol may be invalid or no data available. Skipping.");
    } else if (err.response?.status === 401) {
      console.error("Access token invalid/expired. Regenerate.");
    }
    return null;
  }
}

async function connect() {
  return new Promise(async (resolve, reject) => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error("Max reconnect attempts reached. Manual intervention needed.");
      return reject(new Error("Max reconnect attempts reached"));
    }
    try {
      const url = await getAuthorizedUrl();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        console.log("Closing existing WebSocket.");
        ws.close(1000, "Reconnecting");
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      ws = new WebSocket(url, { followRedirects: true });
      ws.on("open", () => {
        console.log("Connected to Upstox WS");
        reconnectAttempts = 0;
        resubscribeAll();
        const io = ioInstance.getIo();
        if (io) io.emit("ws-reconnected"); // NEW: Notify all clients of successful reconnect
        resolve();
      });
      ws.on("message", async (buffer) => {
        try {
          if (!buffer) return;
          const decoded = FeedResponse.decode(buffer);
          const io = ioInstance.getIo();
          if (!io || typeof io.in !== "function") {
            console.error("Socket.io instance not initialized properly.");
            return;
          }
          for (let symbol of Object.keys(decoded?.feeds || {})) {
            const tick = decoded.feeds[symbol];
            await redisService.setLastTick(symbol, tick);
            // NEW: Add to alert queue for backend processing (offline-capable)
            await alertQueue.add({ symbol, tick });
            // EXISTING: Emit to online users only
            io.in(symbol).emit("tick", { symbol, tick });
          }
        } catch (decodeErr) {
          console.error("Failed to decode WS message:", decodeErr);
          if (decodeErr.message.includes('OOM')) {
            await redisService.cleanupStaleStocks();
          }
        }
      });
      ws.on("close", (code, reason) => {
        console.log(`WS closed: Code ${code}, Reason: ${reason}`);
        reconnectAttempts++;
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
        console.log(`Reconnecting in ${delay / 1000} seconds (Attempt ${reconnectAttempts})...`);
        setTimeout(() => connect().then(resolve).catch(reject), delay);
      });
      ws.on("error", (err) => {
        console.error("WS error:", err.message);
        if (err.message.includes("403")) {
          console.error("403 Forbidden: Check for multiple connections or stale sessions. Fetching fresh URL.");
        }
        if (ws) ws.close();
        reject(err);
      });
    } catch (err) {
      console.error("Connect failed:", err.message);
      reconnectAttempts++;
      const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
      setTimeout(() => connect().then(resolve).catch(reject), delay);
    }
  });
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

// NEW: Function to get WS status
function getWsStatus() {
  if (!ws) return { connected: false, status: 'Not initialized' };
  switch (ws.readyState) {
    case WebSocket.OPEN: return { connected: true, status: 'Connected' };
    case WebSocket.CONNECTING: return { connected: false, status: 'Connecting' };
    case WebSocket.CLOSING: return { connected: false, status: 'Closing' };
    case WebSocket.CLOSED: return { connected: false, status: 'Disconnected' };
    default: return { connected: false, status: 'Unknown' };
  }
}

// Add these exports here (they belong in this file)
exports.subscribe = (symbols) => sendSubscription("sub", symbols);
exports.unsubscribe = (symbols) => sendSubscription("unsub", symbols);
exports.fetchLastClose = fetchLastClose;
exports.connect = connect;
exports.getWsStatus = getWsStatus;
