import { createHash } from 'node:crypto';

export const ACTION_PLAN_COMMAND_IDEMPOTENCY_SCOPE = 'action-plan-command-idempotency-v1';
export const ACTION_PLAN_CLAIM_IDEMPOTENCY_SCOPE = 'action-plan-claim-idempotency-v1';
export const ACTION_PLAN_START_IDEMPOTENCY_SCOPE = 'action-plan-start-idempotency-v1';
export const ACTION_PLAN_RESULT_IDEMPOTENCY_SCOPE = 'action-plan-result-idempotency-v1';

export type CanonicalJsonValue = null | boolean | number | string | CanonicalJsonValue[] | {
  [key: string]: CanonicalJsonValue;
};

export function canonicalizeJson(value: CanonicalJsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON numbers must be finite');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeJson(item)).join(',')}]`;
  }
  const entries = Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalizeJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

export function hashScopedOpaqueValue(scope: string, value: string): string {
  return createHash('sha256')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

export function fingerprintCanonicalValue(scope: string, value: CanonicalJsonValue): string {
  return hashScopedOpaqueValue(scope, canonicalizeJson(value));
}
