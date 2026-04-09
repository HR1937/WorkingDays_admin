const winston = require("winston");

// Define log levels and formats
const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const level = () => {
  const env = process.env.NODE_ENV || "development";
  return env === "production" ? "info" : "debug";
};

const colors = {
  error: "red",
  warn: "yellow",
  info: "green",
  debug: "blue",
};

winston.addColors(colors);

// Console format for development
const consoleFormat = winston.format.combine(
  winston.format.timestamp({ format: "HH:mm:ss" }),
  winston.format.colorize({ all: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? " " + JSON.stringify(meta) : "";
    return `${timestamp} [${level}] ${message}${metaStr}`;
  }),
);

// JSON format for production (structured logging)
const jsonFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Create logger instance
const logger = winston.createLogger({
  level: level(),
  levels,
  format: process.env.NODE_ENV === "production" ? jsonFormat : consoleFormat,
  transports: [
    // Console for all environments
    new winston.transports.Console({
      stderrLevels: ["error"],
      consoleWarnLevels: ["warn", "debug"],
    }),
    // File for errors in production
    ...(process.env.NODE_ENV === "production"
      ? [
          new winston.transports.File({
            filename: "logs/error.log",
            level: "error",
            maxsize: 5242880, // 5MB
            maxFiles: 5,
          }),
          new winston.transports.File({
            filename: "logs/combined.log",
            maxsize: 5242880,
            maxFiles: 10,
          }),
        ]
      : []),
  ],
});

// Create stream for Morgan HTTP logger
logger.stream = {
  write: (message) => logger.info(message.trim()),
};

module.exports = logger;
