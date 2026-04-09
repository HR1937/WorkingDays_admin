require("dotenv").config();
const app = require("./app");
const logger = require("./utils/logger");

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  logger.info(
    `🚀 Server running on port ${PORT} in ${process.env.NODE_ENV} mode`,
  );
  logger.info(`🌐 Local: http://localhost:${PORT}`);
  if (process.env.NODE_ENV === "development") {
    logger.warn("⚠️  Running in development mode - do not use in production");
  }
});

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("🛑 SIGTERM received, shutting down gracefully");
  process.exit(0);
});

process.on("SIGINT", () => {
  logger.info("🛑 SIGINT received, shutting down gracefully");
  process.exit(0);
});
