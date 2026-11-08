import type { Mock } from 'jest-mock';
import { evaluateGamingHybridCandidates } from '../../src/services/gamingHybridCandidates.js';
import { assessGamingSourcePolicy } from '../../src/shared/gaming/gamingFreshnessCore.js';
import { hashGamingApprovedDocument } from '../../src/services/gamingSourceIngestion.js';
import { GAMING_CURRENTNESS_ADAPTER_VERSION } from '../../src/shared/gaming/gamingCurrentnessAdapters.js';

/** Workflow fixtures own synthetic publisher metadata and selected passages.
 * Materialize their source specs through protected HTTP acquisition and source
 * CLEAR so private authority receipts remain real. No authority guard is mocked.
 * This helper does not claim publisher-adapter or live-source acceptance. */
export function gamingHybridAcceptedFixtureMaterializer(http: Mock) {
  return async (outcome: any, _input: unknown, context: Parameters<typeof evaluateGamingHybridCandidates>[1]) => {
    const ids = new Map<string, string>();
    const accepted: Awaited<ReturnType<typeof evaluateGamingHybridCandidates>>['accepted'] = [];
    for (const spec of outcome.accepted) {
      const previousId = spec.candidateId;
      const metadata = spec.freshness;
      const selectedText = (outcome.knowledge.evidence ?? []).filter((chunk: any) => chunk.sourceId === previousId)
        .map((chunk: any) => chunk.text);
      const text = [`${metadata.game} is an action role-playing game.`,
        `In the game ${metadata.game}, the following acquired source applies.`, spec.document.text, ...selectedText]
        .filter((value, index, all) => value && all.indexOf(value) === index).join('\n\n');
      const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      http.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' },
        data: `<html><title>${escape(metadata.game)} guide</title><article>${text.split(/\n+/u)
          .map(paragraph => `<p>${escape(paragraph)}${/[.!?]$/u.test(paragraph) ? '' : '.'}</p>`).join('')}</article></html>` });
      const result = await evaluateGamingHybridCandidates({ game: metadata.game, mode: 'build',
        prompt: text, candidates: [{ url: spec.publicUrl }], discoveryType: metadata.currentness === 'current_index'
          || metadata.currentness === 'live_status' ? 'currentness_verification' : 'gameplay_evidence' }, context, {
        sourcePolicy: (url, game) => ({ ...assessGamingSourcePolicy(url, game),
          ...Object.fromEntries(['category', 'authority', 'currentness', 'ruleId', 'durableAllowed', 'autoStoreAllowed']
            .filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]])) }),
        extractFreshness: document => {
          const acquiredHash = hashGamingApprovedDocument(document);
          const currentnessMetadata = metadata.currentnessMetadata ? structuredClone(metadata.currentnessMetadata)
            : metadata.currentness === 'current_index' ? { game: metadata.game, ruleId: metadata.ruleId,
              adapterId: 'dated-release-index-v1', adapterVersion: GAMING_CURRENTNESS_ADAPTER_VERSION,
              verifiedAt: metadata.verifiedAt, status: 'verified', reasons: ['SYNTHETIC_OFFICIAL_INDEX'],
              currentPatch: metadata.currentPatch, currentBuild: metadata.currentBuild, currentSeason: metadata.currentSeason,
              effectiveFrom: metadata.effectiveFrom, evidenceRefs: [{ url: spec.publicUrl, contentHash: acquiredHash }] } : undefined;
          if (currentnessMetadata?.evidenceRefs) for (const reference of currentnessMetadata.evidenceRefs)
            if (reference.url === spec.publicUrl) reference.contentHash = acquiredHash;
          return { ...metadata, ...(currentnessMetadata ? { currentnessMetadata } : {}) };
        },
        now: () => new Date(metadata.verifiedAt ?? metadata.fetchedAt)
      });
      if (result.accepted.length !== 1) {
        throw new Error(`Synthetic source did not pass real acquisition/CLEAR: ${result.decisions
          .flatMap(decision => decision.reasonCodes).join(', ')}`);
      }
      const candidate = result.accepted[0];
      ids.set(previousId, candidate.candidateId);
      // Tests can continue inspecting source-owned currentness added by the
      // workflow; the accepted object itself retains its private receipt.
      Object.assign(spec, candidate);
      accepted.push(candidate);
    }
    for (const source of outcome.knowledge.sources) {
      source.sourceId = ids.get(source.sourceId) ?? source.sourceId;
      if (source.freshnessMetadata?.id) source.freshnessMetadata.id = ids.get(source.freshnessMetadata.id) ?? source.freshnessMetadata.id;
    }
    for (const chunk of outcome.knowledge.evidence ?? []) chunk.sourceId = ids.get(chunk.sourceId) ?? chunk.sourceId;
    for (const decision of outcome.decisions) if (decision.candidateId)
      decision.candidateId = ids.get(decision.candidateId) ?? decision.candidateId;
    return { ...outcome, accepted };
  };
}
