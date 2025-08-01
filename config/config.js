require("dotenv").config();

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT,
  redisPassword:process.env.REDIS_PASSWORD,
  upstoxAccessToken: process.env.UPSTOX_ACCESS_TOKEN,
  upstoxWsAuthUrl: "https://api.upstox.com/v3/feed/market-data-feed/authorize", // Corrected: Added /market-data-feed/
  upstoxProtoPath: process.env.UPSTOX_PROTO_PATH,
  upstoxRestUrl: "https://api.upstox.com/v3", // new!
  port: process.env.PORT || 5000,
  upstoxApiKey: process.env.UPSTOX_API_KEY,
};
