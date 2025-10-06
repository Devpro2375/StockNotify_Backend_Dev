require("dotenv").config();

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  redisHost: process.env.REDIS_HOST,
  redisPort: process.env.REDIS_PORT,
  redisPassword: process.env.REDIS_PASSWORD,
  upstoxWsAuthUrl: "https://api.upstox.com/v3/feed/market-data-feed/authorize",
  upstoxProtoPath: process.env.UPSTOX_PROTO_PATH,
  upstoxRestUrl: "https://api.upstox.com/v3",
  port: process.env.PORT || 5000,
  upstoxApiKey: process.env.UPSTOX_API_KEY,
  googleClientId: '1005747042622-u76tg782hcrkabcmj1d46l2pusr4p8vn.apps.googleusercontent.com',
  googleClientSecret: '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s',
  googleCallbackURL: process.env.GOOGLE_AUTH_CALLBACK,
  emailHost: 'smtp.gmail.com',
  emailPort: 587,
  emailUser: process.env.EMAIL_USER,
  emailPass: process.env.EMAIL_PASS,
  baseUrl: process.env.BASE_URL,
  frontendBaseUrl: process.env.FRONTEND_BASE_URL,

  sessionSecret: process.env.SESSION_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD,
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT
};
