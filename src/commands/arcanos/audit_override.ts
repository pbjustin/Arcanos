export default function auditOverride(state?: unknown) {
  //audit Assumption: env override should take precedence
  if (process.env.AUDIT_OVERRIDE) {
    return process.env.AUDIT_OVERRIDE;
  }
  return {
    audit: 'Fallback audit value when override is inactive',
    timestamp: new Date().toISOString(),
    state: state ? 'provided' : 'not_provided'
  };
}
