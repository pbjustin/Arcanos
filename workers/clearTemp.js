// AI-Controlled Temp Cleaner Worker
// Cleans temporary data when approved by ARCANOS model

const { modelControlHooks } = require("../dist/services/model-control-hooks");
const { diagnosticsService } = require("../dist/services/diagnostics");
const { createServiceLogger } = require("../dist/utils/logger");

const logger = createServiceLogger("TempCleanerWorker");

const reportFailure = async (error) => {
  logger.error("Worker failure", error);
  try {
    await diagnosticsService.executeDiagnosticCommand(
      `tempCleaner failure: ${error.message}`,
    );
  } catch (diagErr) {
    logger.error("Diagnostics reporting failed", diagErr);
  }
};

module.exports = async function clearTemp() {
  logger.info("Starting AI-controlled temp cleanup");

  try {
    // Request cleanup permission from AI model
    const result = await modelControlHooks.performMaintenance(
      "cleanup",
      { target: "temp", maxAge: "24h" },
      {
        userId: "system",
        sessionId: "temp-cleaner",
        source: "worker",
      },
    );

    if (result.success) {
      logger.info("AI approved temp cleanup operation");

      // Perform AI-approved cleanup
      if (global.gc) {
        global.gc();
        logger.info("Memory garbage collection executed");
      }

      logger.info("Temp cleanup completed successfully");
    } else {
      logger.warning("AI denied temp cleanup operation", result.error);
    }
  } catch (error) {
    await reportFailure(error);
  }
};
