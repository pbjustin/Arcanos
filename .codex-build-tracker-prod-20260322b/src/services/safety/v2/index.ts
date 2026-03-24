/**
 * v2 Trust Verification — Public API
 *
 * Usage:
 *   import { verifyTrustToken, withLock, registerShutdownHooks } from "./services/safety/v2/index.js";
 *
 * Required dependencies (add to package.json):
 *   npm install redis jose
 */

export { V2_CONFIG } from "./config.js";
export { verifyTrustToken, type TrustPayload, type TrustLevel } from "./trustVerify.js";
export { DistributedLock, withLock, type LockLostCallback } from "./lock.js";
export { logAuditEvent, flushAuditLog, type AuditEvent } from "./auditLogger.js";
export { CircuitBreaker } from "./circuitBreaker.js";
export { registerShutdownHooks } from "./shutdown.js";
export { getRedis, disconnectRedis } from "./redisClient.js";
