import { getEnv } from '../../config/env.js';

export default function auditOverride(state?: unknown) {
  //audit Assumption: env override should take precedence
  // Use config layer for env access (adapter boundary pattern)
  const override = getEnv('AUDIT_OVERRIDE');
  if (override) {
    return override;
  }
  return {
    audit: 'Fallback audit value when override is inactive',
    timestamp: new Date().toISOString(),
    state: state ? 'provided' : 'not_provided'
  };
}
