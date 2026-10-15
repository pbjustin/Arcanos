/** Read only the fixed A04 failed-bootstrap receipt from the surviving Web pod. */
import { bindSelfHealPreviewArtifact, buildSelfHealPreviewDatabaseClientOptions,
  resolveSelfHealPreviewProfile } from './railway-self-heal-preview-profile.mjs';
import { verifySelfHealPreviewArtifact } from './self-heal-preview-artifact.mjs';

export async function runSelfHealPreviewStartupReceipt(env, options = {}) {
  if (env.ARCANOS_PROCESS_KIND !== 'web') throw new Error('SELF_HEAL_PREVIEW_STARTUP_EVIDENCE_FAILED');
  const profile = bindSelfHealPreviewArtifact(resolveSelfHealPreviewProfile('web', env, { now: options.now }),
    await (options.verifyArtifact ?? verifySelfHealPreviewArtifact)({ sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA }));
  const { readSelfHealPreviewStartupReceipt } = options.startupModule
    ?? await import('../dist/services/selfImprove/selfHealingPreviewStartup.js');
  return readSelfHealPreviewStartupReceipt(buildSelfHealPreviewDatabaseClientOptions(profile), profile.ownership,
    { createClient: options.createStartupClient });
}
