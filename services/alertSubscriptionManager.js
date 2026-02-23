// services/alertSubscriptionManager.js
// REFACTORED: Uses batch Redis operations, replaced console.log with logger.

const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const { STATUSES } = require("./constants");
const logger = require("../utils/logger");

const SYNC_INTERVAL_MS = 60 * 1000;

let syncTimer = null;
let isSyncing = false;

async function syncAlertSubscriptions() {
  if (isSyncing) return;
  isSyncing = true;

  try {
    const activeKeys = await Alert.distinct("instrument_key", {
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });

    const currentPersistent = await redisService.getPersistentStocks();

    const needed = new Set(activeKeys);
    const current = new Set(currentPersistent);

    const toAdd = activeKeys.filter((s) => !current.has(s));
    const toRemove = currentPersistent.filter((s) => !needed.has(s));

    if (toAdd.length) {
      await Promise.all(toAdd.map((sym) => redisService.addPersistentStock(sym)));
      upstoxService.subscribe(toAdd);
      logger.info(`Alert subscriptions: +${toAdd.length} stocks`, {
        sample: toAdd.slice(0, 5),
      });
    }

    if (toRemove.length) {
      await Promise.all(toRemove.map((sym) => redisService.removePersistentStock(sym)));

      // Batch check user counts via pipeline
      const { redis: client } = require("./redisService");
      const pipeline = client.pipeline();
      for (const sym of toRemove) {
        pipeline.scard(`stock:${sym}:users`);
      }
      const results = await pipeline.exec();

      for (let i = 0; i < toRemove.length; i++) {
        const [, count] = results[i];
        if (count === 0) {
          upstoxService.unsubscribe([toRemove[i]]);
        }
      }
      logger.info(`Alert subscriptions: -${toRemove.length} stocks`);
    }
  } catch (err) {
    logger.error("Alert subscription sync error", { error: err.message });
  } finally {
    isSyncing = false;
  }
}

async function start() {
  logger.info("Alert Subscription Manager starting...");
  await syncAlertSubscriptions();

  try {
    const activeAlertCount = await Alert.countDocuments({
      status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
    });
    const persistentStocks = await redisService.getPersistentStocks();
    logger.info(`Alert Subscription Manager ready: ${activeAlertCount} active alerts across ${persistentStocks.length} stocks`);
  } catch (err) {
    logger.warn("Alert stats fetch error", { error: err.message });
  }

  syncTimer = setInterval(syncAlertSubscriptions, SYNC_INTERVAL_MS);
  syncTimer.unref();
}

function stop() {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
  logger.info("Alert Subscription Manager stopped");
}

module.exports = { start, stop, syncAlertSubscriptions };
