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

   googleClientId: '1005747042622-u76tg782hcrkabcmj1d46l2pusr4p8vn.apps.googleusercontent.com',
  googleClientSecret: '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',
  googleCallbackURL: 'http://localhost:5000/api/auth/google/callback', // Update for production
  emailHost: 'smtp.gmail.com', // Or your email service
  emailPort: 587,
  emailUser: 'stocknotifyservice01@gmail.com',
  emailPass: 'nyxw oxdn mmvz xokh', // Use app password for Gmail
  baseUrl: 'http://localhost:5000',
  frontendBaseUrl: 'http://localhost:3000', // For verification links; update 
 sessionSecret: '9f3b97cfe62a4798a6b8ef1034c72a1d' // 128-bit hex

};
