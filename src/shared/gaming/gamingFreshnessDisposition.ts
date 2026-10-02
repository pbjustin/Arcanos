import { classifyGamingQuestionFreshness, GAMING_SOURCE_POLICY_VERSION,
  type GamingFreshnessEvidence, type GamingFreshnessEvaluation } from './gamingFreshnessCore.js';
import { isGamingGameplayFreshnessEvidence } from './gamingGuideApplicability.js';
import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';

export type GamingFreshnessDisposition = 'NOT_REQUIRED' | 'ADVISORY' | 'REQUIRED';

/** Current-state facts need proof; recommendation usefulness and freshness are separate. */
export function resolveGamingFreshnessDisposition(input: { prompt: string; mode?: string; requestedVersion?: string }): GamingFreshnessDisposition {
  const prompt = input.prompt.slice(0, 8_000).replace(/\bcurrent\s*\/\s*latest\b/giu, 'latest');
  const classification = classifyGamingQuestionFreshness({ ...input, prompt });
  const identityQuestion = /\b(?:what|which)(?:\s+(?:is|are)|['’]s)?\s+(?:the\s+)?(?:current|latest|newest|active)\s+([^?!.\n]{0,80}?)\b(?:patch|hotfix|update|release|version|build|season|league|event)\b/iu.exec(prompt);
  const asksIdentity = Boolean(identityQuestion && !/\b(?:best|build|loadout|strategy|guide|weapon|class|meta)\b/iu.test(identityQuestion[1]));
  const identityBeforeState = /\b(?:what|which)\s+([^?!.\n]{0,80}?)\b(?:patch|hotfix|update|release|version|build)\s+((?:is|are)\b[^?!.\n]{0,80})/iu.exec(prompt);
  const identityStatePredicate = identityBeforeState?.[2].split(/\b(?:and|but|then)\b/iu)[0] ?? '';
  const asksActiveIdentity = Boolean(identityBeforeState
    && /\b(?:current|latest|active|live|running|now|today)\b/iu.test(identityStatePredicate)
    && !/\b(?:best|better|good|viable|effective|optimal|works?|recommended|should)\b/iu.test(identityBeforeState[1] + identityStatePredicate));
  const currentRelease = /\b(?:current|latest|newest|active)\b[^?!.\n]{0,80}\b(?:patch|hotfix|update|release|version)\b/iu.test(prompt);
  const currentStateRequest = prompt.split(/[?!.;\n]|\b(?:and|but|then)\b/iu).some(clause => {
    const object = /\b(?:tell\s+me|show\s+me|identify|list|summarize|describe|explain|report)\s+(?:the\s+)?((?:current|latest|newest|active)\b.{0,120})/iu.exec(clause)?.[1] ?? '';
    return /\b(?:patch|hotfix|update|release)\s+(?:notes|changes|details|number|version|identity)\b/iu.test(object)
      || /\b(?:patch|hotfix|update|release|version|season|league|event)\b/iu.test(object)
      && !/\b(?:build|loadout|strategy|guide|weapons?|class|meta|recommend(?:ation|ations)?|tactics?)\b/iu.test(object);
  });
  if (classification === 'live_status'
    || /\b(?:as\s+of|historical|previous\s+patch|old\s+patch)\b/iu.test(prompt)
    || asksIdentity
    || asksActiveIdentity
    || currentStateRequest
    || currentRelease && !/\b(?:build|loadout|strategy|guide|weapons?|class|meta|recommend(?:ation|ations)?|tactics?)\b/iu.test(prompt)
    || currentRelease && /\b(?:tell\s+me|show\s+me|identify|list)\s+(?:the\s+)?(?:current|latest|newest|active)\b|\bwhat\s+(?:changed|changes)\b|\bpatch\s+(?:number|version)\b/iu.test(prompt)
    || /\b(?:current|latest)\b[^?!.\n]{0,80}\bbuild\s+(?:number|version)\b/iu.test(prompt)
    || /\b(?:what|which)\b.{0,60}\b(?:season|event)\b.{0,30}\b(?:current|active|running|live)\b/iu.test(prompt)
    || /\b(?:is|are)\b.{0,100}\b(?:event|maintenance|servers?)\b.{0,60}\b(?:active|running|available|online|offline|down|live|over|ongoing|today|now)\b/iu.test(prompt)
    || /\b(?:event|maintenance|servers?)\b.{0,40}\b(?:is|are|still)\s+(?:still\s+)?(?:active|running|available|online|offline|down|live|over|ongoing)\b/iu.test(prompt)
    || /\b(?:event|maintenance)\b.{0,40}\b(?:has|have|is)\s+(?:already\s+|now\s+)?(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)
    || /\b(?:has|have|did)\b.{0,60}\b(?:event|maintenance)\b.{0,30}\b(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)) return 'REQUIRED';
  return classification === 'stable' ? 'NOT_REQUIRED' : 'ADVISORY';
}

export const GAMING_UNVERIFIED_GUIDE_WARNING = 'Current patch compatibility could not be verified. These recommendations are based on the available grounded guides and may be outdated if recent balance changes affected these items or mechanics.';
export const GAMING_STALE_GUIDE_WARNING = 'The available grounded guide evidence appears out of date. These recommendations may be outdated, and compatibility with the current patch has not been established.';

/** Obvious affirmative freshness claims are forbidden on qualified recommendations. */
export function gamingAnswerClaimsVerifiedCurrentness(answer: string): boolean {
  const text = answer.replaceAll(GAMING_UNVERIFIED_GUIDE_WARNING, '').replaceAll(GAMING_STALE_GUIDE_WARNING, '')
    .replace(/\b(?:not|never)\s+(?:(?:yet|been|be)\s+){0,2}(?:(?:verified|confirmed|proven|guaranteed)(?:\s+(?:(?:to\s+be|as)\s+)?compatible)?|compatible|tested|updated|optimized)\b/giu, 'unverified');
  return /\b(?:verified|confirmed|proven|guaranteed)(?:\s+(?:to\s+be|as))?\s+(?:current|up[- ]to[- ]date|compatible\s+with\s+(?:the\s+)?(?:latest|current)\s+patch)\b/iu.test(text)
    || /\b(?:this|the|these|my|our)\s+(?:[\p{L}\p{N}'’-]+\s+){0,6}(?:build|guide|recommendations?|advice|loadout|strategy)\s+(?:is|are|remains?)\s+(?:verified\s+)?(?:current|up[- ]to[- ]date|(?:latest|current)[- ]patch\s+compatible)\b/iu.test(text)
    || /\b(?:this|the|these|my|our)\s+(?:build|guide|recommendations?|advice|loadout|strategy)\s+(?:(?:is|are|remains?)\s+)?(?:verified\s+)?(?:current|up[- ]to[- ]date)\b/iu.test(text)
    || /\b(?:here\s+is|this\s+is|these\s+are|use|choose|equip|try|this|these|our|my)\s+(?:an?\s+|the\s+)?(?:current|latest|newest|up[- ]to[- ]date)\s+(?:[\p{L}\p{N}'’-]+\s+){0,6}(?:build|guide|recommendations?|loadout|strategy|meta)\b/iu.test(text)
    || /\b(?:compatible\s+with|works?\s+on|valid\s+for|tested\s+(?:on|for)|updated\s+for|optimized\s+for|verified\s+for)\s+(?:the\s+)?(?:latest|current|newest)\s+(?:patch|build|release|version)\b/iu.test(text)
    || /\b(?:latest|current|newest)\s+patch\s+(?:compatible|compatibility\s+(?:is\s+)?(?:verified|confirmed|established|proven))\b/iu.test(text)
    || /\b(?:current|latest|newest|active)\s+(?:patch|hotfix|update|release|build(?:\s+(?:number|version))?)\s*(?:is|are|:|=)\s*(?:v(?:ersion)?\.?\s*)?\d/iu.test(text)
    || /\b(?:on|for|in)\s+(?:the\s+)?(?:current|latest|newest)\s+patch\s+(?:v(?:ersion)?\.?\s*)?\d/iu.test(text)
    || /\b(?:is|are|remains?)\s+(?:the\s+)?(?:current|latest)\s+(?:best|meta|optimal|strongest|build|guide|recommendation)\b/iu.test(text);
}

/** Only these non-security acquisition failures permit a qualified recommendation. */
export function isGamingAdvisoryCurrentnessOperation(input: {
  decisions: readonly { decision: string; reasonCodes: readonly string[] }[];
}): boolean {
  const unavailable = new Set(['INSUFFICIENT_EXTRACTION', 'SOURCE_FETCH_FAILED', 'SOURCE_TIMEOUT', 'FETCH_BUDGET_EXHAUSTED']);
  return input.decisions.length > 0 && input.decisions.every(item => item.decision !== 'rejected'
    || item.reasonCodes.length > 0 && item.reasonCodes.every(reason => unavailable.has(reason)));
}

/** This selects gameplay only; callers must still pass the independent bounded CLEAR assessment. */
export function selectGamingAdvisoryGameplayEvidence(input: {
  game: string;
  freshness: GamingFreshnessEvaluation;
  evidence: readonly GamingFreshnessEvidence[];
  now: Date;
}): { selectedEvidenceIds: string[]; status: 'unverified' | 'stale'; qualification: string; conflict: boolean } {
  const gameplay = input.evidence.filter(item => isGamingGameplayFreshnessEvidence(item)
    && item.policyVersion === GAMING_SOURCE_POLICY_VERSION
    && normalizeGamingGameIdentity(item.game) === normalizeGamingGameIdentity(input.game));
  const claims = new Map<string, string>();
  let conflict = input.freshness.status === 'conflicting'
    || gameplay.some(item => item.metadataConflict || item.currentnessMetadata?.status === 'conflicting')
    || input.freshness.guideApplicability?.some(item => item.status === 'conflicting'
      || item.reasons.includes('CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC')) === true;
  for (const item of gameplay) for (const [key, value] of Object.entries(item.mechanicValues ?? {}).slice(0, 16)) {
    if (claims.has(key) && claims.get(key) !== value) conflict = true;
    claims.set(key, value);
  }
  const stale = input.freshness.status === 'stale'
    || input.freshness.guideApplicability?.some(item => item.status === 'stale') === true
    || gameplay.some(item => item.effectiveUntil && Number.isFinite(Date.parse(item.effectiveUntil))
      && Date.parse(item.effectiveUntil) <= input.now.getTime());
  return { selectedEvidenceIds: conflict ? [] : gameplay.map(item => item.id), status: stale ? 'stale' : 'unverified',
    qualification: stale ? GAMING_STALE_GUIDE_WARNING : GAMING_UNVERIFIED_GUIDE_WARNING, conflict };
}
