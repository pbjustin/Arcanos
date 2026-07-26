import type { Request } from 'express';

import {
  createRateLimitMiddleware,
} from '@platform/runtime/security.js';

export const WORKER_HEAL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const WORKER_HEAL_RATE_LIMIT_MAX = 10;

function getWorkerHealPrincipalRateLimitKey(req: Request): string {
  if (req.authUser && Number.isInteger(req.authUser.id)) {
    return `worker-auth-user:${req.authUser.id}`;
  }

  if (req.daemonToken) {
    return 'worker-trusted-daemon-context';
  }

  if (typeof req.operatorActor === 'string' && req.operatorActor.trim()) {
    return 'worker-established-operator-context';
  }

  // Authentication runs before this middleware. The remaining direct/helper
  // path is therefore the one configured worker-helper credential identity;
  // the credential value never enters a rate key.
  return 'worker-helper-credential';
}

/**
 * One principal budget across both worker-heal HTTP entry points.
 */
export const workerHealMutationRateLimit = createRateLimitMiddleware({
  bucketName: 'worker-heal-control',
  maxRequests: WORKER_HEAL_RATE_LIMIT_MAX,
  windowMs: WORKER_HEAL_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getWorkerHealPrincipalRateLimitKey,
});
