// utils/logger.js
// Structured Winston logger — JSON in production, colorized in dev.
// REFACTORED: Added service label for multi-service filtering.

const { createLogger, format, transports } = require("winston");

const isProd = process.env.NODE_ENV === "production";

const logger = createLogger({
  level: isProd ? "info" : "debug",
  defaultMeta: { service: "stocknotify" },
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss.SSS" }),
    format.errors({ stack: true }),
    isProd
      ? format.json()
      : format.combine(
          format.colorize(),
          format.printf(({ timestamp, level, message, service, ...meta }) => {
            const extra = Object.keys(meta).length
              ? " " + JSON.stringify(meta)
              : "";
            return `${timestamp} ${level}: ${message}${extra}`;
          })
        )
  ),
  transports: [new transports.Console()],
});

module.exports = logger;
