import { config } from "../config/env.js";

const levels = ["error", "warn", "info", "debug"];
const activeLevelIndex = levels.indexOf(config.audit.level);

function shouldLog(level) {
  const index = levels.indexOf(level);
  if (index === -1) {
    return false;
  }
  if (activeLevelIndex === -1) {
    return level === "info";
  }
  return index <= activeLevelIndex;
}

export const auditService = {
  record(event) {
    if (!shouldLog("info")) {
      return;
    }
    const entry = {
      ...event,
      timestamp: new Date().toISOString(),
      env: config.env
    };
    console.log(`[AUDIT] ${entry.timestamp} ${entry.method} ${entry.path} ${entry.status} ${entry.durationMs}ms`);
  }
};
