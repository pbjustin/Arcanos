const { createServiceLogger } = require("../dist/utils/logger");
let MaintenanceSchedulerWorker;
try {
  ({
    maintenanceSchedulerWorker: MaintenanceSchedulerWorker,
  } = require("../dist/workers/maintenance-scheduler"));
} catch {
  ({
    maintenanceSchedulerWorker: MaintenanceSchedulerWorker,
  } = require("../src/workers/maintenance-scheduler"));
}
const logger = createServiceLogger("MaintenanceSchedulerWorker");

module.exports = async function maintenanceScheduler() {
  logger.info("Executing maintenanceScheduler worker");
  try {
    await MaintenanceSchedulerWorker.start();
    logger.success("Maintenance scheduler started");
  } catch (err) {
    logger.error("Maintenance scheduler failed", err);
    throw err;
  }
};
