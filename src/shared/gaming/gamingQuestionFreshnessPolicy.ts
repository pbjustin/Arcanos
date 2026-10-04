export type GamingQuestionFreshness = 'stable' | 'patch_sensitive' | 'seasonal' | 'live_status';
export type GamingFreshnessDisposition = 'NOT_REQUIRED' | 'ADVISORY' | 'REQUIRED';

/** Question policy is conservative even when an explicit client mode says "guide". */
export function classifyGamingQuestionFreshness(input: { prompt: string; mode?: string; requestedVersion?: string }): GamingQuestionFreshness {
  const prompt = input.prompt.slice(0, 8_000);
  if (/\b(?:server\s+(?:status|outage|maintenance|down)|servers?\s+(?:are\s+)?(?:down|offline)|outage|login\s+(?:issues?|problems?)|maintenance\s+(?:now|today)|live\s+status|current\s+event\s+status)\b/iu.test(prompt)
    || /\bmaintenance\b[^?!.\n]{0,40}\b(?:end(?:s|ed)?|start(?:s|ed)?|begin(?:s)?|finish(?:es|ed)?|scheduled)\b[^?!.\n]{0,30}\b(?:now|today|currently|tonight|tomorrow)\b/iu.test(prompt)
    || /\b(?:is|are)\b.{0,100}\b(?:event|maintenance|servers?)\b.{0,60}\b(?:active|running|available|online|offline|down|live|over|ongoing|today|now)\b/iu.test(prompt)
    || /\b(?:event|maintenance|servers?)\b.{0,40}\b(?:is|are|still)\s+(?:still\s+)?(?:active|running|available|online|offline|down|live|over|ongoing)\b/iu.test(prompt)
    || /\b(?:event|maintenance)\b.{0,40}\b(?:has|have|is)\s+(?:already\s+|now\s+)?(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)
    || /\b(?:has|have|did)\b.{0,60}\b(?:event|maintenance)\b.{0,30}\b(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)
    || /\b(?:what|which)\b.{0,60}\bevent\b.{0,30}\b(?:current|active|running|live)\b/iu.test(prompt)) return 'live_status';
  if (/\b(?:season|seasonal|battle\s+pass|current\s+league)\b/iu.test(prompt)) return 'seasonal';
  // Strength questions occur in either order ("best build" / "which build is best").
  // Keep ordinary routes and puzzles stable unless their own question needs freshness.
  const combatSubject = /\b(?:weapons?|builds?|class(?:es)?|loadouts?|talents?|equipment|skills?|abilit(?:y|ies)|gear|armou?r|rotations?)\b/iu.test(prompt);
  const effectivenessOrTime = /\b(?:best|better|strong(?:est|er)?|weak(?:est|er)?|effective(?:ness)?|powerful|optimal|viab(?:le|ility)|top|good|today|currently|now)\b/iu.test(prompt);
  const recommendationIntent = /\b(?:recommend(?:ed|ation|ations)?|suggest(?:ed|ion|ions)?)\b|\bshould\b.{0,80}\b(?:choose|pick|select|use|equip|play)\b/iu.test(prompt);
  if (input.requestedVersion || input.mode === 'meta' || input.mode === 'build' || (combatSubject && (effectivenessOrTime || recommendationIntent))
    || /\bwhat\s+(?:changed|changes)\b[^?!.\n]{0,60}\b(?:today|now|currently)\b/iu.test(prompt)
    || /\b(?:patch|hotfix|balance|nerf|buff|meta|viable|latest|current(?!\s+(?:area|checkpoint|location|objective|progress|quest)\b)|right\s+now|dps|damage\s+(?:value|number)|weapon\s+effectiveness|(?:best|strongest)\s+(?:weapon|build|class|loadout|talent|equipment))\b/iu.test(prompt)) return 'patch_sensitive';
  return 'stable';
}

/** Current-state facts need proof; recommendation usefulness and freshness are separate. */
export function resolveGamingFreshnessDisposition(input: { prompt: string; mode?: string; requestedVersion?: string }): GamingFreshnessDisposition {
  const prompt = input.prompt.slice(0, 8_000).replace(/\bcurrent\s*\/\s*latest\b/giu, 'latest')
    .replace(/\bcurrent\s+(area|checkpoint|location|objective|progress|quest)\b/giu, '$1')
    .replace(/\bmy\s+current\s+(build|loadout|class|weapon|gear)\b/giu, 'my existing $1');
  const classification = classifyGamingQuestionFreshness({ ...input, prompt });
  const identityQuestion = /\b(?:what|which)(?:\s+(?:is|are)|['’]s)?\s+(?:the\s+)?(?:current|latest|newest|active)\s+([^?!.\n]{0,80}?)\b(?:patch|hotfix|update|release|version|build|season|league|event)\b/iu.exec(prompt);
  const asksIdentity = Boolean(identityQuestion && !/\b(?:best|build|loadout|strategy|guide|weapon|class|meta)\b/iu.test(identityQuestion[1]));
  const identityBeforeState = /\b(?:what|which)\s+([^?!.\n]{0,80}?)\b(?:patch|hotfix|update|release|version|build)\s+((?:is|are)\b[^?!.\n]{0,80})/iu.exec(prompt);
  const identityStatePredicate = identityBeforeState?.[2].split(/\b(?:and|but|then)\b/iu)[0] ?? '';
  const asksActiveIdentity = Boolean(identityBeforeState
    && /\b(?:current|latest|active|live|running|now|today)\b/iu.test(identityStatePredicate)
    && !/\b(?:best|better|good|viable|effective|optimal|works?|recommended|should)\b/iu.test(identityBeforeState[1] + identityStatePredicate));
  const currentRelease = /\b(?:current|latest|newest|active)\b[^?!.\n]{0,80}\b(?:patch|hotfix|update|release|version)\b/iu.test(prompt);
  const explicitCurrentRecommendation = /\b(?:current|latest|newest)\b[^?!.\n]{0,80}\b(?:meta|builds?|loadouts?|strateg(?:y|ies)|weapons?|class(?:es)?|recommendations?)\b/iu.test(prompt)
    || /\b(?:meta|builds?|loadouts?|strateg(?:y|ies)|weapons?|class(?:es)?)\b[^?!.\n]{0,80}\b(?:currently|right\s+now|current\s+meta)\b/iu.test(prompt)
    || /\b(?:today|now|currently)\b/iu.test(prompt) && /\b(?:best|strongest|optimal|meta)\b/iu.test(prompt)
      && /\b(?:weapons?|builds?|class(?:es)?|loadouts?|strateg(?:y|ies))\b/iu.test(prompt);
  const currentStateRequest = prompt.split(/[?!.;\n]|\b(?:and|but|then)\b/iu).some(clause => {
    const object = /\b(?:tell\s+me|show\s+me|identify|list|summarize|describe|explain|report)\s+(?:the\s+)?((?:current|latest|newest|active)\b.{0,120})/iu.exec(clause)?.[1] ?? '';
    return /\b(?:patch|hotfix|update|release)\s+(?:notes|changes|details|number|version|identity)\b/iu.test(object)
      || /\b(?:patch|hotfix|update|release|version|season|league|event)\b/iu.test(object)
      && !/\b(?:build|loadout|strategy|guide|weapons?|class|meta|recommend(?:ation|ations)?|tactics?)\b/iu.test(object);
  });
  if (input.requestedVersion
    || classification === 'live_status'
    || currentRelease
    || explicitCurrentRecommendation
    || /\bwhat\s+(?:changed|changes)\b[^?!.\n]{0,60}\b(?:today|now|currently)\b/iu.test(prompt)
    || /\b(?:as\s+of|historical|previous\s+patch|old\s+patch)\b/iu.test(prompt)
    || asksIdentity
    || asksActiveIdentity
    || currentStateRequest
    || /\b(?:current|latest)\b[^?!.\n]{0,80}\bbuild\s+(?:number|version)\b/iu.test(prompt)
    || /\b(?:what|which)\b.{0,60}\b(?:season|event)\b.{0,30}\b(?:current|active|running|live)\b/iu.test(prompt)
    || /\b(?:is|are)\b.{0,100}\b(?:event|maintenance|servers?)\b.{0,60}\b(?:active|running|available|online|offline|down|live|over|ongoing|today|now)\b/iu.test(prompt)
    || /\b(?:event|maintenance|servers?)\b.{0,40}\b(?:is|are|still)\s+(?:still\s+)?(?:active|running|available|online|offline|down|live|over|ongoing)\b/iu.test(prompt)
    || /\b(?:event|maintenance)\b.{0,40}\b(?:has|have|is)\s+(?:already\s+|now\s+)?(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)
    || /\b(?:has|have|did)\b.{0,60}\b(?:event|maintenance)\b.{0,30}\b(?:end(?:ed)?|finish(?:ed)?|begun|started|cancelled|canceled|postponed)\b/iu.test(prompt)) return 'REQUIRED';
  return classification === 'stable' ? 'NOT_REQUIRED' : 'ADVISORY';
}
