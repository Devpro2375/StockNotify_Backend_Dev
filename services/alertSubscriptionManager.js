// services/alertSubscriptionManager.js
// Background service that ensures ALL stocks with active alerts are
// subscribed to the Upstox WebSocket feed — regardless of whether
// any user has the browser open.

const Alert = require("../models/Alert");
const redisService = require("./redisService");
const upstoxService = require("./upstoxService");
const { STATUSES } = require("./constants");

const SYNC_INTERVAL_MS = 60 * 1000; // Re-sync every 60 seconds

let syncTimer = null;
let isSyncing = false;

/**
 * Core sync logic — queries MongoDB for all active alert instrument keys,
 * compares against Redis persistent:stocks, and subscribes/unsubscribes.
 */
async function syncAlertSubscriptions() {
    if (isSyncing) return; // Prevent overlapping runs
    isSyncing = true;

    try {
        // 1. Get all unique instrument_keys from active alerts
        const activeKeys = await Alert.distinct("instrument_key", {
            status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
        });

        // 2. Get currently persistent stocks in Redis
        const currentPersistent = await redisService.getPersistentStocks();

        const needed = new Set(activeKeys);
        const current = new Set(currentPersistent);

        // 3. Determine additions and removals
        const toAdd = activeKeys.filter((s) => !current.has(s));
        const toRemove = currentPersistent.filter((s) => !needed.has(s));

        // 4. Add new persistent subscriptions
        if (toAdd.length) {
            await Promise.all(
                toAdd.map((sym) => redisService.addPersistentStock(sym))
            );
            upstoxService.subscribe(toAdd);
            console.log(
                `📡 Alert subscriptions: +${toAdd.length} stocks (${toAdd.slice(0, 5).join(", ")}${toAdd.length > 5 ? "..." : ""})`
            );
        }

        // 5. Remove stocks that no longer have active alerts
        if (toRemove.length) {
            await Promise.all(
                toRemove.map((sym) => redisService.removePersistentStock(sym))
            );

            // Only unsubscribe from Upstox if no users are watching either
            for (const sym of toRemove) {
                const userCount = await redisService.getStockUserCount(sym);
                if (userCount === 0) {
                    upstoxService.unsubscribe([sym]);
                }
            }
            console.log(
                `📡 Alert subscriptions: -${toRemove.length} stocks`
            );
        }

        if (toAdd.length === 0 && toRemove.length === 0) {
            // Silent — no changes needed
        }
    } catch (err) {
        console.error("❌ Alert subscription sync error:", err.message);
    } finally {
        isSyncing = false;
    }
}

/**
 * Start the background alert subscription manager.
 * Call once on server boot after DB connection is established.
 */
async function start() {
    console.log("🚀 Alert Subscription Manager starting...");

    // Initial sync — subscribe to all alert stocks immediately
    await syncAlertSubscriptions();

    // Log stats
    try {
        const activeAlertCount = await Alert.countDocuments({
            status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
        });
        const persistentStocks = await redisService.getPersistentStocks();
        console.log(
            `✅ Alert Subscription Manager ready: ${activeAlertCount} active alerts across ${persistentStocks.length} stocks`
        );
    } catch (err) {
        console.error("⚠️ Alert stats fetch error:", err.message);
    }

    // Periodic re-sync
    syncTimer = setInterval(syncAlertSubscriptions, SYNC_INTERVAL_MS);
}

/**
 * Stop the background sync (for graceful shutdown).
 */
function stop() {
    if (syncTimer) {
        clearInterval(syncTimer);
        syncTimer = null;
    }
    console.log("🛑 Alert Subscription Manager stopped");
}

module.exports = {
    start,
    stop,
    syncAlertSubscriptions, // Exposed for manual trigger (e.g., after adding/removing alert)
};
