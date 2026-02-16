import { createApp } from "./app.js";
import { config } from "./config/index.js";
import { logger } from "./utils/logger.js";
import http from "http";

/**
 * Purpose: Start the upload HTTP server with graceful shutdown and crash logging hooks.
 * Inputs/Outputs: No inputs; starts listening on configured port and exits on fatal startup failure.
 * Edge cases: Shutdown signals are handled idempotently to avoid duplicate close attempts.
 */
async function main() {
  const app = await createApp();
  const server = http.createServer(app);
  let shuttingDown = false;

  server.listen(config.PORT, () => {
    logger.info(`Server running on port ${config.PORT}`);
  });

  process.on("unhandledRejection", (reason) => {
    logger.error({ reason }, "Unhandled Rejection");
  });

  process.on("uncaughtException", (error) => {
    logger.fatal({ error }, "Uncaught Exception");
    shutdown();
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  function shutdown() {
    //audit Assumption: multiple shutdown signals can arrive during container stop windows.
    //audit Failure risk: duplicate close calls can produce noisy or misleading logs.
    //audit Invariant: server close logic executes at most once.
    //audit Handling: short-circuit repeat shutdown calls using local guard.
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    logger.info("Graceful shutdown initiated");

    const forcedExitTimer = setTimeout(() => {
      logger.error("Forced shutdown timeout reached");
      process.exit(1);
    }, 10_000);
    forcedExitTimer.unref();

    server.close(() => {
      clearTimeout(forcedExitTimer);
      logger.info("Server closed");
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error(err, "Failed to start server");
  process.exit(1);
});
