const { mountArcanosInternal } = require('../scripts/codex-internal');

let enabled = false;

/**
 * Enable Codex interface by mounting internal modules.
 * This ensures Codex can resolve compiled files when executing
 * within the repository.
 */
export function enableCodexInterface(): void {
  if (enabled) return;
  try {
    mountArcanosInternal();
    enabled = true;
    console.log('[CODEX-INTEGRATOR] Codex interface enabled');
  } catch (err) {
    console.error('[CODEX-INTEGRATOR] Failed to enable Codex interface:', (err as Error).message);
  }
}
