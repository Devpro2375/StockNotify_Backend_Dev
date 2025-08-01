const redis = require("redis");
const config = require("../config/config");

const client = redis.createClient({
  socket: { host: config.redisHost, port: config.redisPort }, 
  password: config.redisPassword // Important: add password
});
client.on("error", (err) => console.log("Redis Client Error", err));
client.connect();

exports.addUserToStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  await client.sAdd(`stock:${symbol}:users`, userIdStr);
  await client.sAdd("global:stocks", symbol);
};

exports.removeUserFromStock = async (userId, symbol) => {
  const userIdStr = String(userId);
  await client.sRem(`stock:${symbol}:users`, userIdStr);
};

exports.getStockUserCount = async (symbol) =>
  client.sCard(`stock:${symbol}:users`);

exports.removeStockFromGlobal = async (symbol) => {
  await client.sRem("global:stocks", symbol);
  await client.del(`stock:${symbol}:users`);
};

exports.getUserStocks = async (userId) => {
  const userIdStr = String(userId);
  const all = await client.sMembers("global:stocks");
  const result = [];
  for (const sym of all) {
    if (await client.sIsMember(`stock:${sym}:users`, userIdStr))
      result.push(sym);
  }
  return result;
};

exports.getAllGlobalStocks = async () => await client.sMembers("global:stocks");

exports.cleanupStaleStocks = async () => {
  const all = await exports.getAllGlobalStocks();
  for (const sym of all) {
    if ((await exports.getStockUserCount(sym)) === 0)
      await exports.removeStockFromGlobal(sym);
  }
};

exports.cleanupUser = async (userId) => {
  const all = await client.sMembers("global:stocks");
  for (const sym of all) {
    await exports.removeUserFromStock(userId, sym);
    if ((await exports.getStockUserCount(sym)) === 0) {
      require("./upstoxService").unsubscribe([sym]);
      await exports.removeStockFromGlobal(sym);
    }
  }
};

exports.setLastTick = (symbol, tick) =>
  client.hSet("stock:lastTick", symbol, JSON.stringify(tick));

exports.getLastTick = async (symbol) => {
  const v = await client.hGet("stock:lastTick", symbol);
  return v ? JSON.parse(v) : null;
};

exports.setLastClosePrice = (symbol, data) =>
  client.hSet("stock:lastClose", symbol, JSON.stringify(data));

exports.getLastClosePrice = async (symbol) => {
  const v = await client.hGet("stock:lastClose", symbol);
  return v ? JSON.parse(v) : null;
};
