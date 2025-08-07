const WebSocket = require("ws");
const axios = require("axios");
const config = require("../config/config");
const ioInstance = require("./ioInstance");
const redisService = require("./redisService");
const Queue = require('bull');

// Load Protobuf (unchanged)
const protoRoot = require("../proto/marketdata.js");
let FeedResponse;
try {
  FeedResponse =
    protoRoot.com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse;
  console.log("Loaded FeedResponse using exact package path (v3udapi)");
} catch (e) {
  try {
    FeedResponse =
      protoRoot.com.upstox.marketdatafeederv3udapi.proto.FeedResponse;
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

// Tick queue
const tickQueue = new Queue('tick-processing', {
  redis: { host: config.redisHost, port: config.redisPort, password: config.redisPassword }
});

let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;

async function getAuthorizedUrl() {
  try {
    const res = await axios.get(config.upstoxWsAuthUrl, {
      headers: { Authorization: `Bearer ${config.upstoxAccessToken}` }
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
  if (allStocks.length) exports.subscribe(allStocks);
}

async function fetchLastClose(instrumentKey) {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const res = await axios.get(
      `${config.upstoxRestUrl}/historical/v3/${instrumentKey}/days/1`,
      {
        params: { to_date: today },
        headers: { Authorization: `Bearer ${config.upstoxAccessToken}` },
      }
    );
    const candles = res.data.data.candles;
    if (!candles.length) {
      console.warn(`No historical data for ${instrumentKey} on ${today}`);
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
    console.error(`Error fetching historical for ${instrumentKey}:`, err.message);
    if (err.response?.status === 404) {
      console.warn("Symbol may be invalid or no data available. Skipping.");
    } else if (err.response?.status === 401) {
      console.error("Access token invalid/expired. Regenerate.");
    }
    return null;
  }
}

async function connect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error("Max reconnect attempts reached. Manual intervention needed.");
    return;
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
        await tickQueue.add({ symbol, tick }, {
        removeOnComplete: { age: 30, count: 1000 }, // Remove completed after 30s or 1000 jobs
        removeOnFail: { age: 60, count: 500 } // Remove failed after 60s or 500 jobs
                   });
          io.in(symbol).emit("tick", { symbol, tick });
        }
      } catch (decodeErr) {
        console.error("Failed to decode WS message:", decodeErr);
        if (decodeErr.message.includes('OOM')) {
          await redisService.cleanupStaleStocks(); // Emergency cleanup
        }
      }
    });

    ws.on("close", (code, reason) => {
      console.log(`WS closed: Code ${code}, Reason: ${reason}`);
      reconnectAttempts++;
      const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
      console.log(`Reconnecting in ${delay / 1000} seconds (Attempt ${reconnectAttempts})...`);
      setTimeout(connect, delay);
    });

    ws.on("error", (err) => {
      console.error("WS error:", err.message);
      if (err.message.includes("403")) {
        console.error("403 Forbidden: Check for multiple connections or stale sessions. Fetching fresh URL.");
      }
      if (ws) ws.close();
    });
  } catch (err) {
    console.error("Connect failed:", err.message);
    reconnectAttempts++;
    const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
    setTimeout(connect, delay);
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

exports.subscribe = (symbols) => sendSubscription("sub", symbols);
exports.unsubscribe = (symbols) => sendSubscription("unsub", symbols);
exports.fetchLastClose = fetchLastClose;
exports.connect = connect;