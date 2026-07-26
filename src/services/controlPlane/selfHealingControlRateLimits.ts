import type { Request } from 'express';

import { createRateLimitMiddleware } from '@platform/runtime/security.js';

export const SELF_HEALING_CONTROL_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
export const SELF_HEALING_DECISION_RATE_LIMIT_MAX = 20;
export const SELF_IMPROVE_CONTROL_RATE_LIMIT_MAX = 10;

export function getSelfHealingPrincipalRateLimitKey(req: Request): string {
  return `principal:${req.controlPlanePrincipal?.principalId ?? 'missing'}:self-healing-control`;
}

/**
 * Shared across both decision entry points so switching namespaces cannot
 * multiply the execution-capable request allowance.
 */
export const selfHealingDecisionRateLimit = createRateLimitMiddleware({
  bucketName: 'self-heal-decision',
  maxRequests: SELF_HEALING_DECISION_RATE_LIMIT_MAX,
  windowMs: SELF_HEALING_CONTROL_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getSelfHealingPrincipalRateLimitKey,
});

export const selfImproveControlRateLimit = createRateLimitMiddleware({
  bucketName: 'self-improve-control',
  maxRequests: SELF_IMPROVE_CONTROL_RATE_LIMIT_MAX,
  windowMs: SELF_HEALING_CONTROL_RATE_LIMIT_WINDOW_MS,
  keyGenerator: getSelfHealingPrincipalRateLimitKey,
});
