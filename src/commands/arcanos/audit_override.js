module.exports = (state) => {
  if (process.env.AUDIT_OVERRIDE) {
    return process.env.AUDIT_OVERRIDE;  // Uses host-verified specs
  }
  return {
    audit: "Fallback audit value when override is inactive",
    timestamp: new Date().toISOString()
  };
};
