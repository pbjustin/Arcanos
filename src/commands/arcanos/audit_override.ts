export default function auditOverride(state?: any) {
  if (process.env.AUDIT_OVERRIDE) {
    return process.env.AUDIT_OVERRIDE;
  }
  return {
    audit: 'Fallback audit value when override is inactive',
    timestamp: new Date().toISOString(),
    state: state ? 'provided' : 'not_provided'
  };
}
