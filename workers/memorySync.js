// AI-Controlled Memory Sync Worker
// Executes only when approved by ARCANOS model

const { modelControlHooks } = require("../dist/services/model-control-hooks");
const { diagnosticsService } = require("../dist/services/diagnostics");
const { createServiceLogger } = require("../dist/utils/logger");

const logger = createServiceLogger("MemorySyncWorker");

const reportFailure = async (error) => {
  logger.error("Worker failure", error);
  try {
    await diagnosticsService.executeDiagnosticCommand(
      `memorySync failure: ${error.message}`,
    );
  } catch (diagErr) {
    logger.error("Diagnostics reporting failed", diagErr);
  }
};

module.exports = async function memorySync() {
  logger.info("Starting AI-controlled memory sync");

  try {
    // Request permission from AI model
    const result = await modelControlHooks.manageMemory(
      "list",
      {},
      {
        userId: "system",
        sessionId: "memory-sync",
        source: "worker",
      },
    );

    if (result.success) {
      logger.info("AI approved memory sync operation");

      // Perform memory sync operations as directed by AI
      const syncResult = await modelControlHooks.manageMemory(
        "store",
        {
          key: "sync_timestamp",
          value: new Date().toISOString(),
          tags: ["system", "sync"],
        },
        {
          userId: "system",
          sessionId: "memory-sync",
          source: "worker",
        },
      );

      if (syncResult.success) {
        logger.info("Memory sync completed successfully");
      } else {
        logger.error("Memory sync failed", syncResult.error);
      }
    } else {
      logger.warning("AI denied memory sync operation", result.error);
    }
  } catch (error) {
    await reportFailure(error);
  }
};
