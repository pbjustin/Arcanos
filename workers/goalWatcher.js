// AI-Controlled Goal Watcher Worker
// Monitors goals through ARCANOS model instructions

const { diagnosticsService } = require("../dist/services/diagnostics");
const { createServiceLogger } = require("../dist/utils/logger");
const { checkModelControlHooks } = require("../dist/utils/overlay-diagnostics");

const logger = createServiceLogger("GoalWatcherWorker");

const reportFailure = async (error) => {
  logger.error("Worker failure", error);
  try {
    await diagnosticsService.executeDiagnosticCommand(
      `goalWatcher failure: ${error.message}`,
    );
  } catch (diagErr) {
    logger.error("Diagnostics reporting failed", diagErr);
  }
};

module.exports = async function goalWatcher() {
  logger.info("Starting AI-controlled goal monitoring");

  try {
    const hooksOk = await checkModelControlHooks();
    let modelControlHooks;
    if (hooksOk) {
      ({ modelControlHooks } = require("../dist/services/model-control-hooks"));
    } else {
      logger.warning("Overlay reroute executed - skipping goal monitoring");
      return;
    }

    // Request goal monitoring from AI model
    const result = await modelControlHooks.manageMemory(
      "list",
      {},
      {
        userId: "system",
        sessionId: "goal-watcher",
        source: "worker",
      },
    );

    if (result.success && result.results) {
      const memories = result.results[0]?.result || [];
      const goals = memories.filter(
        (memory) => memory.tags && memory.tags.includes("goal"),
      );

      logger.info("Found goals to monitor", { count: goals.length });

      // Report goal status to AI model
      const reportResult = await modelControlHooks.performAudit(
        { goals: goals.length, timestamp: new Date().toISOString() },
        "goal_monitoring",
        {
          userId: "system",
          sessionId: "goal-watcher",
          source: "worker",
        },
      );

      if (reportResult.success) {
        logger.info("Goal monitoring report sent to AI", {
          response: reportResult.response,
        });
      }
    } else {
      logger.warning("AI denied goal monitoring operation", result.error);
    }
  } catch (error) {
    await reportFailure(error);
  }
};
