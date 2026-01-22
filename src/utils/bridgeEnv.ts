function hasExplicitBridgeFlag(): boolean {
  return typeof process.env.BRIDGE_ENABLED === 'string';
}

export function isBridgeEnabled(): boolean {
  const raw = process.env.BRIDGE_ENABLED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  if (hasExplicitBridgeFlag()) {
    return false;
  }

  // Default to enabled on Railway deployments so IPC can come online without manual env wiring.
  return Boolean(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID);
}

export default {
  isBridgeEnabled
};
