const cron = require("node-cron");
const redisService = require("./redisService");
const { fetchLastClose } = require("./upstoxService");
const { STATUSES } = require("./constants");
const { updateInstruments } = require("./instrumentService");
const UpstoxTokenRefresh = require("./upstoxTokenRefresh");
const Alert = require("../models/Alert");

function init() {
  console.log("⏰ Initializing Scheduler Service...");

  // 1) Upstox token auto-refresh — daily 6:30 AM IST
  cron.schedule(
    "30 6 * * *",
    async () => {
      console.log(
        `[${new Date().toISOString()}] 🔄 Upstox token refresh started`
      );
      try {
        const refresher = new UpstoxTokenRefresh();
        const result = await refresher.refreshToken();
        if (result.success) {
          console.log(
            `[${new Date().toISOString()}] ✅ Token refresh successful - expires at ${
              result.expiresAt
            }`
          );
        } else {
          console.error(
            `[${new Date().toISOString()}] ❌ Token refresh failed: ${
              result.error
            }`
          );
        }
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] ❌ Token refresh error:`,
          err.message
        );
      }
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log("✅ Upstox token refresh cron scheduled at 6:30 AM IST daily");

  // 2) Periodic preload of close prices (every 5 minutes)
  cron.schedule("*/5 * * * *", async () => {
    try {
      const syms = await redisService.getAllGlobalStocks();
      for (const symbol of syms) {
        await fetchLastClose(symbol);
      }
      console.log(
        `[${new Date().toISOString()}] ✅ Periodic preload complete.`
      );
    } catch (err) {
      console.error("❌ Error in periodic preload:", err);
    }
  });

  // 3) Cleanup persistent stocks (every 5 minutes)
  cron.schedule("*/5 * * * *", async () => {
    try {
      const persistent = await redisService.getPersistentStocks();
      for (const symbol of persistent) {
        const activeAlerts = await Alert.countDocuments({
          instrument_key: symbol,
          status: { $nin: [STATUSES.SL_HIT, STATUSES.TARGET_HIT] },
        });
        if (
          activeAlerts === 0 &&
          (await redisService.getStockUserCount(symbol)) === 0
        ) {
          await redisService.removePersistentStock(symbol);
          require("./upstoxService").unsubscribe([symbol]);
          console.log(`🧹 Cleaned persistent stock: ${symbol}`);
        }
      }
      console.log(
        `[${new Date().toISOString()}] ✅ Cleaned up persistent stocks`
      );
    } catch (err) {
      console.error("❌ Error in persistent stock cleanup:", err);
    }
  });

  // 4) Daily instrument update at 6:30 AM IST
  cron.schedule(
    "30 6 * * *",
    async () => {
      try {
        console.log("🔄 Starting scheduled daily instrument update...");
        const result = await updateInstruments();
        console.log(
          `[${new Date().toISOString()}] ✅ Instrument update complete: ${
            result.count
          } instruments (deleted ${result.deleted} old)`
        );
      } catch (err) {
        console.error(
          `[${new Date().toISOString()}] ❌ Scheduled instrument update failed:`,
          err.message
        );
      }
    },
    { timezone: "Asia/Kolkata" }
  );
  console.log("✅ Instrument update cron scheduled at 6:30 AM IST daily");
}

module.exports = { init };
