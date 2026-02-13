import { app } from "./app.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import http from "http";

const server = http.createServer(app);

server.listen(config.PORT, () => {
  logger.info(`Server running on port ${config.PORT}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "Unhandled Rejection");
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  logger.info("Graceful shutdown initiated");
  server.close(() => {
    logger.info("Server closed");
    process.exit(0);
  });
}
