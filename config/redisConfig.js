// config/redisConfig.js
// Shared Redis connection config for all Bull queues.
// Avoids circular dependency between queues and redisService.

const config = require("./config");

module.exports = {
  host: config.redisHost,
  port: config.redisPort,
  password: config.redisPassword,
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
};
