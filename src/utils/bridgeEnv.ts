import { env, Environment } from './env.js';

function hasExplicitBridgeFlag(): boolean {
  return typeof env.BRIDGE_ENABLED === 'string';
}

export function isBridgeEnabled(): boolean {
  const raw = env.BRIDGE_ENABLED;
  if (raw === 'true') return true;
  if (raw === 'false') return false;

  if (hasExplicitBridgeFlag()) {
    return false;
  }

  // Default to enabled on Railway deployments so IPC can come online without manual env wiring.
  return Environment.isRailway();
}

export default {
  isBridgeEnabled
};
