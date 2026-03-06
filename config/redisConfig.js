// config/redisConfig.js
// Shared Redis connection config for all Bull queues.
// Avoids circular dependency between queues and redisService.

const config = require("./config");

const redisConfig = {
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};

if (config.redisUsername) {
  redisConfig.username = config.redisUsername;
}

if (config.redisTls) {
  redisConfig.tls = { rejectUnauthorized: false };
}

module.exports = redisConfig;
