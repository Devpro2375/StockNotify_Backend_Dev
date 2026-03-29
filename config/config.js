require("dotenv").config();

const rawRedisUrl =
  process.env.REDIS_URL ||
  process.env.REDIS_PUBLIC_URL ||
  process.env.REDIS_PRIVATE_URL ||
  "";

let parsedRedis = null;
if (rawRedisUrl) {
  try {
    parsedRedis = new URL(rawRedisUrl);
  } catch {
    parsedRedis = null;
  }
}

const redisProtocol = parsedRedis?.protocol || "";
const redisHost = process.env.REDIS_HOST || parsedRedis?.hostname;
const redisPort = Number(process.env.REDIS_PORT || parsedRedis?.port || 6379);
const redisPassword =
  process.env.REDIS_PASSWORD ||
  (parsedRedis?.password ? decodeURIComponent(parsedRedis.password) : undefined);
const redisUsername =
  process.env.REDIS_USERNAME ||
  (parsedRedis?.username ? decodeURIComponent(parsedRedis.username) : undefined);
const redisTls =
  process.env.REDIS_TLS === "true" ||
  redisProtocol === "rediss:";

module.exports = {
  mongoURI: process.env.MONGO_URI,
  jwtSecret: process.env.JWT_SECRET,
  redisHost,
  redisPort,
  redisPassword,
  redisUsername,
  redisTls,
  redisUrl: rawRedisUrl || null,
  upstoxWsAuthUrl: "https://api.upstox.com/v3/feed/market-data-feed/authorize",
  upstoxProtoPath: process.env.UPSTOX_PROTO_PATH,
  upstoxRestUrl: "https://api.upstox.com",
  port: process.env.PORT || 5000,
  upstoxApiKey: process.env.UPSTOX_API_KEY,

  googleClientId: process.env.GOOGLE_CLIENT_ID,  
  googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,  
  googleCallbackURL: process.env.GOOGLE_AUTH_CALLBACK,
  emailHost: 'smtp.gmail.com',
  emailPort: 587,
  emailUser: process.env.EMAIL_USER,
  emailPass: process.env.EMAIL_PASS,
  resendApiKey: process.env.RESEND_API_KEY, // Add this line
  baseUrl: process.env.BASE_URL,
  frontendBaseUrl: process.env.FRONTEND_BASE_URL,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
  telegramWebhookUrl: process.env.TELEGRAM_WEBHOOK_URL || null,
  sessionSecret: process.env.SESSION_SECRET,
  adminPassword: process.env.ADMIN_PASSWORD,
  firebaseServiceAccount: process.env.FIREBASE_SERVICE_ACCOUNT
};

// --------------------------------------------------
// Required environment variable validation
// --------------------------------------------------
const REQUIRED_ENV_VARS = ["MONGO_URI", "JWT_SECRET"];
const missingVars = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  console.error(
    `[config] FATAL: Missing required environment variable(s): ${missingVars.join(", ")}. ` +
      "Server cannot start without these values.",
  );
  throw new Error(
    `Missing required environment variables: ${missingVars.join(", ")}`,
  );
}
