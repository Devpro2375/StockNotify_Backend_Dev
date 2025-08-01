const WebSocket = require("ws");
const https = require("https");
const axios = require("axios");
const config = require("../config/config");
const ioInstance = require("./ioInstance");
const redisService = require("./redisService");

// Load Protobuf (unchanged from your code)
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

let ws = null;

function getAuthorizedUrl() {
  return new Promise((resolve, reject) => {
    https
      .get(
        config.upstoxWsAuthUrl,
        {
          headers: { Authorization: `Bearer ${config.upstoxAccessToken}` },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            const json = JSON.parse(data);
            if (!json.data?.authorized_redirect_uri)
              return reject(new Error("Invalid Upstox response"));
            resolve(json.data.authorized_redirect_uri);
          });
        }
      )
      .on("error", reject);
  });
}

async function resubscribeAll() {
  const globalStocks = await redisService.getAllGlobalStocks();
  if (globalStocks.length) exports.subscribe(globalStocks);
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
    console
      .error
      // `Error fetching historical for ${instrumentKey}:`,
      // err.message
      ();
    return null;
  }
}

async function connect(retryCount = 0) {
  try {
    const url = await getAuthorizedUrl();
    ws = new WebSocket(url, { followRedirects: true });

    ws.on("open", () => {
      console.log("Connected to Upstox WS");
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
          io.in(symbol).emit("tick", { symbol, tick });
        }
      } catch (decodeErr) {
        console.error("Failed to decode WS message:", decodeErr);
      }
    });

    ws.on("close", () => setTimeout(() => connect(0), 5000));
    ws.on("error", (err) => {
      console.error("WS error:", err);
      ws.close();
    });
  } catch (err) {
    if (retryCount < 5) setTimeout(() => connect(retryCount + 1), 5000);
    else console.error("Max retries reached for Upstox connection");
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

