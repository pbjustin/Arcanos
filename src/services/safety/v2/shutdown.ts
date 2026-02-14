/**
 * v2 Trust Verification — Graceful Shutdown
 *
 * Registers SIGTERM / SIGINT handlers to cleanly disconnect Redis
 * and flush pending audit entries before exit. Uses process.exitCode
 * instead of process.exit() to allow async cleanup to complete.
 */

import { disconnectRedis } from "./redisClient.js";
import { logAuditEvent, flushAuditLog } from "./auditLogger.js";

let registered = false;
let shuttingDown = false;

export function registerShutdownHooks(): void {
  if (registered) return;
  registered = true;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return; // guard against re-entrancy
    shuttingDown = true;

    logAuditEvent({ type: "SHUTDOWN", signal });

    try {
      await flushAuditLog();
    } catch {
      // best-effort
    }

    try {
      await disconnectRedis();
    } catch {
      // best-effort
    }

    process.exitCode = 0;
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}
