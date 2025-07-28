const { createServiceLogger } = require("../dist/utils/logger");
let scheduleEmailWorker;
try {
  ({
    scheduleEmailWorker,
  } = require("../dist/workers/email/schedule-email-worker"));
} catch {
  ({
    scheduleEmailWorker,
  } = require("../src/workers/email/schedule-email-worker"));
}
const logger = createServiceLogger("ScheduledEmailsWorker");

module.exports = async function scheduled_emails_worker(options) {
  logger.info("Executing scheduled_emails_worker");
  if (!options || !options.cron || !options.request) {
    logger.error("Invalid schedule options");
    throw new Error("invalid_schedule");
  }
  const task = scheduleEmailWorker(options);
  if (!task) {
    logger.error("emailDispatcher not registered, schedule rejected");
    throw new Error("dispatch_unavailable");
  }
  logger.success("Scheduled emailDispatcher task");
  return task;
};
