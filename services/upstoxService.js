// services/upstoxService.js - FIXED PROTO LOADING

const WebSocket = require('ws');
const axios = require('axios');
const config = require('../config/config');
const ioInstance = require('./ioInstance');
const redisService = require('./redisService');
const AccessToken = require('../models/AccessToken');

// ==================== PROTOBUF LOADING FIX ====================
const protobuf = require('protobufjs');
const path = require('path');

let FeedResponse;

// Option 1: Load from compiled .js file
try {
  const protoRoot = require('../proto/marketdata.js');
  
  // Try all possible paths
  const possiblePaths = [
    'com.upstox.marketdatafeeder.rpc.proto.FeedResponse',
    'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
    'com.upstox.marketdatafeeder.proto.FeedResponse',
    'upstox.marketdatafeeder.proto.FeedResponse',
    'FeedResponse'
  ];
  
  for (const protoPath of possiblePaths) {
    try {
      FeedResponse = protoPath.split('.').reduce((obj, key) => obj?.[key], protoRoot);
      if (FeedResponse && typeof FeedResponse.decode === 'function') {
        console.log(`✅ Loaded FeedResponse from compiled proto: ${protoPath}`);
        break;
      }
    } catch (e) {
      continue;
    }
  }
} catch (e) {
  console.warn('⚠️ Could not load from compiled proto, trying .proto file...');
}

// Option 2: Load directly from .proto file (FALLBACK)
if (!FeedResponse || typeof FeedResponse.decode !== 'function') {
  console.log('🔄 Loading from .proto file...');
  
  try {
    const protoPath = path.join(__dirname, '../proto/MarketDataFeed.proto');
    const root = protobuf.loadSync(protoPath);
    
    // Try to find FeedResponse in the loaded root
    const possiblePaths = [
      'com.upstox.marketdatafeeder.rpc.proto.FeedResponse',
      'com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse',
      'FeedResponse'
    ];
    
    for (const protoPath of possiblePaths) {
      try {
        FeedResponse = root.lookupType(protoPath);
        if (FeedResponse) {
          console.log(`✅ Loaded FeedResponse from .proto file: ${protoPath}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (err) {
    console.error('❌ Failed to load .proto file:', err.message);
  }
}

// Final validation
if (!FeedResponse || typeof FeedResponse.decode !== 'function') {
  console.error('❌ CRITICAL: Failed to load FeedResponse');
  console.error('Available proto structure:', JSON.stringify(require('../proto/marketdata.js'), null, 2));
  throw new Error(`
    Failed to load FeedResponse from protobuf.
    
    TROUBLESHOOTING:
    1. Check if proto/MarketDataFeed.proto exists
    2. Recompile proto file:
       npx pbjs -t static-module -w commonjs -o proto/marketdata.js proto/MarketDataFeed.proto
       npx pbts -o proto/marketdata.d.ts proto/marketdata.js
    3. Verify FeedResponse message exists in .proto file
    4. Check package name in .proto file matches code
  `);
}

console.log('✅ FeedResponse loaded successfully');

// ==================== WEBSOCKET STATE ====================
let ws = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY = 5000;
const subscriptionQueue = new Set();

// ==================== TOKEN MANAGEMENT ====================
async function getAccessTokenFromDB() {
  const tokenDoc = await AccessToken.findOne();
  if (!tokenDoc || !tokenDoc.token) {
    throw new Error('No access token found in database. Please update via admin dashboard.');
  }
  return tokenDoc.token;
}

async function getAuthorizedUrl() {
  try {
    const accessToken = await getAccessTokenFromDB();
    const res = await axios.get(config.upstoxWsAuthUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      timeout: 10000
    });

    if (!res.data?.data?.authorizedRedirectUri) {
      throw new Error('Invalid Upstox auth response');
    }

    console.log('✅ Fetched fresh authorized WebSocket URL');
    return res.data.data.authorizedRedirectUri;
  } catch (err) {
    console.error('❌ Failed to fetch authorized URL:', err.message);
    
    if (err.response?.status === 401) {
      console.error('❌ Access token expired! Regenerate it via admin dashboard.');
    }
    
    throw err;
  }
}

// ==================== HISTORICAL DATA ====================
async function fetchLastClose(instrumentKey) {
  try {
    const accessToken = await getAccessTokenFromDB();
    const today = new Date().toISOString().slice(0, 10);
    
    const res = await axios.get(
      `${config.upstoxRestUrl}/historical-candle/${instrumentKey}/day/1`,
      {
        params: { to_date: today },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000
      }
    );

    const candles = res.data.data.candles;
    
    if (!candles || candles.length === 0) {
      console.warn(`⚠️ No historical data for ${instrumentKey}`);
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
    if (err.response?.status === 404) {
      // console.warn(`⚠️ Symbol ${instrumentKey} may be invalid or no data available`);
    } else if (err.response?.status === 401) {
      console.error('❌ Access token invalid/expired. Regenerate via admin.');
    } else {
      console.error(`❌ Error fetching historical for ${instrumentKey}:`, err.message);
    }
    
    return null;
  }
}

// ==================== SUBSCRIPTION MANAGEMENT ====================
function sendSubscription(method, symbols) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    console.warn(`⚠️ WebSocket not ready for ${method}. Queuing symbols:`, symbols);
    
    if (method === 'sub') {
      symbols.forEach(s => subscriptionQueue.add(s));
    }
    
    return false;
  }

  try {
    ws.send(Buffer.from(JSON.stringify({
      guid: 'someguid',
      method,
      data: {
        mode: 'full',
        instrumentKeys: symbols,
      },
    })));
    
    console.log(`📡 ${method.toUpperCase()}: ${symbols.join(', ')}`);
    return true;
  } catch (err) {
    console.error(`❌ Failed to send ${method}:`, err.message);
    return false;
  }
}

async function resubscribeAll() {
  const globalStocks = await redisService.getAllGlobalStocks();
  const persistentStocks = await redisService.getPersistentStocks();
  const allStocks = [...new Set([...globalStocks, ...persistentStocks, ...subscriptionQueue])];

  const toSubscribe = [];
  
  for (const symbol of allStocks) {
    if (await redisService.shouldSubscribe(symbol)) {
      toSubscribe.push(symbol);
    }
  }

  if (toSubscribe.length > 0) {
    console.log(`🔄 Resubscribing to ${toSubscribe.length} symbols`);
    
    const BATCH_SIZE = 100;
    for (let i = 0; i < toSubscribe.length; i += BATCH_SIZE) {
      const batch = toSubscribe.slice(i, i + BATCH_SIZE);
      sendSubscription('sub', batch);
      
      if (i + BATCH_SIZE < toSubscribe.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    
    subscriptionQueue.clear();
  }
}

// ==================== MESSAGE HANDLER ====================
async function handleMessage(buffer) {
  try {
    if (!buffer || buffer.length === 0) return;

    const decoded = FeedResponse.decode(buffer);
    const io = ioInstance.getIo();

    if (!io || typeof io.in !== 'function') {
      console.error('❌ Socket.io instance not initialized properly');
      return;
    }

    const { alertQueue } = require('./alertService');

    for (const symbol of Object.keys(decoded?.feeds || {})) {
      const tick = decoded.feeds[symbol];
      
      await redisService.setLastTick(symbol, tick);
      
      await alertQueue.add({ symbol, tick }, {
        removeOnComplete: true,
        removeOnFail: false,
      });
      
      io.in(symbol).emit('tick', { symbol, tick });
    }
  } catch (decodeErr) {
    console.error('❌ Failed to decode WS message:', decodeErr.message);
    
    if (decodeErr.message.includes('OOM') || decodeErr.message.includes('memory')) {
      console.warn('⚠️ Memory issue detected. Cleaning up stale stocks...');
      await redisService.cleanupStaleStocks();
    }
  }
}

// ==================== CONNECTION MANAGEMENT ====================
async function connect() {
  return new Promise(async (resolve, reject) => {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      console.error('❌ Max reconnect attempts reached. Manual intervention needed.');
      return reject(new Error('Max reconnect attempts reached'));
    }

    try {
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        console.log('🔄 Closing existing WebSocket...');
        ws.close(1000, 'Reconnecting');
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      const url = await getAuthorizedUrl();
      ws = new WebSocket(url, { followRedirects: true });

      ws.on('open', async () => {
        console.log('✅ Connected to Upstox WebSocket');
        reconnectAttempts = 0;
        
        await resubscribeAll();
        
        const io = ioInstance.getIo();
        if (io) {
          io.emit('ws-reconnected', { timestamp: new Date().toISOString() });
        }
        
        resolve();
      });

      ws.on('message', handleMessage);

      ws.on('close', (code, reason) => {
        console.log(`⚠️ WebSocket closed - Code: ${code}, Reason: ${reason || 'None'}`);
        reconnectAttempts++;
        
        const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
        console.log(`🔄 Reconnecting in ${delay / 1000} seconds (Attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
        
        setTimeout(() => {
          connect().then(resolve).catch(reject);
        }, delay);
      });

      ws.on('error', (err) => {
        console.error('❌ WebSocket error:', err.message);
        
        if (err.message.includes('403')) {
          console.error('❌ 403 Forbidden - Check for multiple connections or stale sessions');
        }
        
        if (ws) {
          ws.close();
        }
      });

    } catch (err) {
      console.error('❌ Connection failed:', err.message);
      reconnectAttempts++;
      
      const delay = BASE_RECONNECT_DELAY * Math.pow(2, reconnectAttempts - 1);
      
      setTimeout(() => {
        connect().then(resolve).catch(reject);
      }, delay);
    }
  });
}

// ==================== STATUS MONITORING ====================
function getWsStatus() {
  if (!ws) {
    return { connected: false, status: 'Not initialized' };
  }

  const statusMap = {
    [WebSocket.OPEN]: { connected: true, status: 'Connected' },
    [WebSocket.CONNECTING]: { connected: false, status: 'Connecting' },
    [WebSocket.CLOSING]: { connected: false, status: 'Closing' },
    [WebSocket.CLOSED]: { connected: false, status: 'Disconnected' },
  };

  return statusMap[ws.readyState] || { connected: false, status: 'Unknown' };
}

// ==================== GRACEFUL SHUTDOWN ====================
async function cleanup() {
  if (ws && ws.readyState !== WebSocket.CLOSED) {
    console.log('🛑 Closing Upstox WebSocket...');
    ws.close(1000, 'Server shutdown');
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// ==================== EXPORTS ====================
module.exports = {
  connect,
  subscribe: (symbols) => sendSubscription('sub', symbols),
  unsubscribe: (symbols) => sendSubscription('unsub', symbols),
  fetchLastClose,
  getWsStatus,
  cleanup,
};
