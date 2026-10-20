import { readFileSync, statSync } from 'node:fs';

const POLICY_URL = new URL('../config/railway-gaming-preview.json', import.meta.url);
const issuedConfigurations = new WeakSet();
const POLICY_KEYS = ['hostedActivation', 'scope', 'statusContext', 'version'];

function requirePolicy(condition) {
  if (!condition) throw new Error('GAMING_PREVIEW_TRUSTED_POLICY_INVALID');
}

/** Validate reviewed policy without granting a caller-supplied object authority. */
export function validateGamingPreviewPolicy(value) {
  requirePolicy(value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('|') === POLICY_KEYS.join('|')
    && value.version === 1 && value.scope === 'gaming-synthetic-v1'
    && value.statusContext === 'Railway Gaming Scoped Preview E2E'
    && value.hostedActivation === 'trusted-controller-receipt-only');
}

/** The caller cannot supply a candidate path, environment override or scope. */
export function resolveTrustedGamingPreviewConfiguration() {
  requirePolicy(arguments.length === 0);
  requirePolicy(statSync(POLICY_URL).isFile() && statSync(POLICY_URL).size <= 4096);
  const value = JSON.parse(readFileSync(POLICY_URL, 'utf8'));
  validateGamingPreviewPolicy(value);
  const configuration = Object.freeze(value);
  issuedConfigurations.add(configuration);
  return configuration;
}

/** An equivalent JSON object is not a configuration issued by this module. */
export function assertTrustedGamingPreviewConfiguration(value) {
  requirePolicy(issuedConfigurations.has(value));
  validateGamingPreviewPolicy(value);
}
