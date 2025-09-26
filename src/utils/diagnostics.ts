import { getEnvironmentSecuritySummary } from './environmentSecurity.js';

export function runHealthCheck() {
  console.log('[🩺 HealthCheck] Running diagnostics');
  const mem = process.memoryUsage();
  const heapMB = (mem.heapUsed / 1024 / 1024).toFixed(2);
  const uptime = process.uptime().toFixed(1);
  const security = getEnvironmentSecuritySummary();
  console.log(`[🩺 HealthCheck] Heap: ${heapMB}MB | Uptime: ${uptime}s`);

  if (security) {
    console.log(`[🛡️ Security] Trusted=${security.trusted} SafeMode=${security.safeMode}`);
  }

  return {
    summary: `Heap: ${heapMB}MB | Uptime: ${uptime}s`,
    raw: mem,
    security
  };
}