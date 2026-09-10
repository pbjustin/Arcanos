import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { GAMING_EVIDENCE_UNIT_POLICY_VERSION } from './gamingEvidenceUnits.js';
import { resolveGamingAnswerPolicy } from './gamingAnswerPolicy.js';
import { buildGamingRetrievalTerms, gamingLexicalTokens, gamingTermCoverage } from './gamingRetrievalPolicy.js';

export const GAMING_STRUCTURAL_SUFFICIENCY_VERSION = 'gaming-structural-sufficiency/v1';
export const GAMING_STRUCTURAL_EVIDENCE_LIMITS = Object.freeze({ units: 2_048, unitChars: 4_096, usableUnitChars: 2_000, fields: 32, valueChars: 1_024 });
export type GamingStructuralClaimShape = 'location' | 'statistic' | 'patch_change' | 'build' | 'none';
export interface GamingStructuralUsability {
  hasIntactUsableUnit: boolean;
  claimShape: GamingStructuralClaimShape;
  claimSupported: boolean;
  usableUnitIds: string[];
  supportingUnitIds: string[];
  missingFields: string[];
  reasonCodes: string[];
}

const aliases: Readonly<Record<string, string>> = Object.freeze({
  system: 'system', 'star system': 'system', body: 'body', planet: 'body', moon: 'body',
  site: 'site', 'site number': 'site', 'site identifier': 'site', 'pml/site': 'site', pml: 'site',
  siteid: 'site', 'site id': 'site', site_id: 'site', 'site-id': 'site',
  resource: 'resource', material: 'resource', mineral: 'resource',
  item: 'item', equipment: 'item', weapon: 'item', armor: 'item', armour: 'item',
  stat: 'stat', statistic: 'stat', attribute: 'stat', value: 'value', unit: 'unit', units: 'unit',
  scope: 'scope', applicability: 'scope', patch: 'patch', version: 'patch', edition: 'scope',
  mechanic: 'mechanic', change: 'change', before: 'before', after: 'after', skill: 'skill', build: 'build'
});
const normal = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
function mentionsValue(request: string, value: string): boolean {
  let index = request.indexOf(value);
  while (index >= 0) {
    if (!/[\p{L}\p{N}]/u.test(request[index - 1] ?? '') && !/[\p{L}\p{N}]/u.test(request[index + value.length] ?? '')) return true;
    index = request.indexOf(value, index + 1);
  }
  return false;
}
function fieldKey(label: string): string {
  const normalized = normal(label);
  return aliases[normalized] ?? aliases[normalized.split(/\s+\/\s+/u).at(-1)!] ?? normalized;
}
const boundedString = (value: unknown, limit: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit;

/** Validate backend persisted metadata without inventing structural provenance for legacy records. */
export function readGamingEvidenceUnits(value: unknown, sourceUrl?: string, text?: string): GamingEvidenceUnit[] {
  if (!Array.isArray(value) || value.length > GAMING_STRUCTURAL_EVIDENCE_LIMITS.units) return [];
  return value.filter((entry): entry is GamingEvidenceUnit => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    const unit = entry as GamingEvidenceUnit;
    if (!boundedString(unit.id, 160) || !['paragraph', 'table_row', 'list_item', 'definition', 'structured_record'].includes(unit.kind)
      || !boundedString(unit.text, GAMING_STRUCTURAL_EVIDENCE_LIMITS.unitChars) || !Array.isArray(unit.fields)
      || unit.fields.length > GAMING_STRUCTURAL_EVIDENCE_LIMITS.fields || !unit.fields.every(field => field
        && boundedString(field.label, 160) && typeof field.value === 'string' && field.value.length <= GAMING_STRUCTURAL_EVIDENCE_LIMITS.valueChars
        && normal(unit.text).includes(normal(field.value)))
      || !unit.context || !boundedString(unit.context.scope, 200)
      || [unit.context.heading, unit.context.caption, unit.context.attribution].some(item => item !== undefined && !boundedString(item, 512))
      || unit.context.qualifiers !== undefined && (!Array.isArray(unit.context.qualifiers) || unit.context.qualifiers.length > 16
        || !unit.context.qualifiers.every(item => boundedString(item, 512) && normal(unit.text).includes(normal(item))))
      || !unit.integrity || !['complete', 'partial', 'ambiguous'].includes(unit.integrity.status)
      || !Array.isArray(unit.integrity.reasons) || unit.integrity.reasons.length > 16 || !unit.integrity.reasons.every(item => boundedString(item, 80))
      || !unit.provenance || unit.provenance.policyVersion !== GAMING_EVIDENCE_UNIT_POLICY_VERSION
      || !boundedString(unit.provenance.sourceUrl, 2_048) || !boundedString(unit.provenance.locator, 300)
      || !['html_table', 'html_list', 'html_definition', 'json_ld', 'application_json', 'prose'].includes(unit.provenance.strategy)
      || !['html_dom', 'json_pointer', 'normalized_text'].includes(unit.provenance.representation)
      || sourceUrl !== undefined && unit.provenance.sourceUrl !== sourceUrl
      || text !== undefined && !text.includes(unit.text)) return false;
    return true;
  });
}

function intact(unit: GamingEvidenceUnit): boolean {
  return unit.kind !== 'paragraph' && unit.text.length <= GAMING_STRUCTURAL_EVIDENCE_LIMITS.usableUnitChars
    && unit.integrity.status === 'complete' && unit.integrity.reasons.length === 0
    && unit.fields.length >= 2 && unit.fields.filter(field => Object.values(aliases).includes(fieldKey(field.label))).length >= 2
    && new Set(unit.fields.map(field => fieldKey(field.label))).size === unit.fields.length
    && unit.fields.every(field => field.value.trim().length > 0 && !/^(?:unknown|n\/?a|not specified|[-?—]+)$/iu.test(field.value.trim()));
}

function shape(input: { prompt?: string; mode?: string }, units: readonly GamingEvidenceUnit[]): GamingStructuralClaimShape {
  if (!input.prompt) return 'none';
  const prompt = input.prompt;
  const keys = new Set(units.flatMap(unit => unit.fields.map(field => fieldKey(field.label))));
  const locationFields = new Set((prompt.toLowerCase().match(/\b(?:system|body|site|resource)\b/gu) ?? []));
  if (['system', 'body', 'site', 'resource'].some(key => keys.has(key)) && (locationFields.size >= 2
    || resolveGamingAnswerPolicy({ prompt }).task === 'lookup' || /\b(?:where|location|locate)\b/iu.test(prompt))) return 'location';
  if (/\b(?:patch|hotfix|change|changed|before|after|nerf|buff)\b/iu.test(prompt) && ['mechanic', 'change', 'before', 'after'].some(key => keys.has(key))) return 'patch_change';
  if (/\b(?:stat|statistic|damage|weight|value|units?|scaling)\b/iu.test(prompt) && ['item', 'stat', 'value'].some(key => keys.has(key))) return 'statistic';
  if (input.mode === 'build' && ['build', 'item', 'skill'].some(key => keys.has(key))) return 'build';
  return 'none';
}

function requiredFields(claimShape: GamingStructuralClaimShape, fields: Map<string, string>): string[] {
  if (claimShape === 'location') return ['system', 'body', 'site', 'resource'];
  if (claimShape === 'statistic') return ['item', 'stat', 'value', 'unit', fields.has('patch') ? 'patch' : 'scope'];
  if (claimShape === 'patch_change') return ['mechanic', ...(fields.has('change') ? ['change'] : ['before', 'after']), fields.has('patch') ? 'patch' : 'scope'];
  if (claimShape === 'build') return ['build', 'item', 'skill', fields.has('patch') ? 'patch' : 'scope'];
  return [];
}

// Field names and request verbs are not requested entity values. This is a
// closed claim adapter; lexical retrieval retains its existing general policy.
const REQUEST_FORMAT_TERMS = new Set('give show list find exact location locations located report reports reporting source sources record records table rows system star body planet moon site number identifier pml resource material mineral stat statistic statistics value values unit units item equipment weapon armor armour scope edition patch version mechanic change changed changes before after build skill state says according contains includes information detail details'.split(' '));

/** Explicit request labels bind whole values to fields, including identifiers absent from the source. */
function requestedFieldBindings(prompt: string, claimShape: GamingStructuralClaimShape): Map<string, Set<string>> {
  const labelPattern = 'star system|system|body|planet|moon|site number|site identifier|site|resource|material|mineral|item|equipment|weapon|statistic|stat|mechanic|patch|edition|build|skill';
  const prefix = new RegExp(`\\b(${labelPattern})(?:\\s*[:=]\\s*|\\s+)`, 'giu');
  const nextField = new RegExp(`^(?:and\\s+)?(?:${labelPattern})\\b|\\s+(?:(?:and|in|on|for|at|with)\\s+)?(?:${labelPattern})\\b`, 'iu');
  const bindings = new Map<string, Set<string>>();
  const allowed = new Set(claimShape === 'location' ? ['system', 'body', 'site', 'resource']
    : claimShape === 'statistic' ? ['item', 'stat', 'unit', 'scope', 'patch']
    : claimShape === 'patch_change' ? ['mechanic', 'patch', 'scope']
    : claimShape === 'build' ? ['build', 'item', 'skill', 'scope', 'patch'] : []);
  for (const match of prompt.slice(0, 8_000).matchAll(prefix)) {
    const tail = prompt.slice(match.index + match[0].length, match.index + match[0].length + 161);
    const boundary = /[,;?!\n]|\.(?=\s|$)|\s+(?:in|with|for|at|on|from)\s+/u.exec(tail);
    const next = nextField.exec(tail);
    const end = Math.min(boundary?.index ?? tail.length, next?.index ?? tail.length);
    const value = normal(tail.slice(0, end).replace(/^(?:named|called)\s+/iu, '').replace(/^["']|["']$/gu, ''));
    if (!value || value.length > 160 || REQUEST_FORMAT_TERMS.has(value)
      || /^(?:and|or|is|are|reports?|reporting|contains?|includes?|of|do|does|should|would|can)\b/iu.test(value)) continue;
    const key = fieldKey(match[1]);
    if (!allowed.has(key)) continue;
    const values = bindings.get(key) ?? new Set<string>(); values.add(value); bindings.set(key, values);
  }
  return bindings;
}

function conflictingUnits(units: readonly GamingEvidenceUnit[], claimShape: GamingStructuralClaimShape): Set<GamingEvidenceUnit> {
  const assertions = new Map<string, { units: GamingEvidenceUnit[]; values: Set<string> }>();
  for (const unit of units) {
    const fields = new Map(unit.fields.map(field => [fieldKey(field.label), normal(field.value)]));
    const identityKeys = claimShape === 'location' ? ['system', 'body', 'site']
      : claimShape === 'statistic' ? ['item', 'stat', fields.has('patch') ? 'patch' : 'scope']
      : claimShape === 'patch_change' ? ['mechanic', fields.has('patch') ? 'patch' : 'scope'] : [];
    if (!identityKeys.length || identityKeys.some(key => !fields.get(key))) continue;
    const identity = JSON.stringify([unit.provenance.sourceUrl, ...identityKeys.map(key => fields.get(key))]);
    const valueKeys = claimShape === 'location' ? ['resource'] : claimShape === 'statistic' ? ['value', 'unit'] : ['change', 'before', 'after'];
    if (!valueKeys.some(key => fields.get(key))) continue;
    const assertion = JSON.stringify([...valueKeys.map(key => fields.get(key) ?? null), ...(unit.context.qualifiers ?? []).map(normal)]);
    const entry = assertions.get(identity) ?? { units: [], values: new Set<string>() };
    entry.values.add(assertion); entry.units.push(unit); assertions.set(identity, entry);
  }
  return new Set([...assertions.values()].filter(entry => entry.values.size > 1).flatMap(entry => entry.units));
}

/** Document-wide source disagreements are retained, never resolved toward a user's requested value. */
export function markGamingEvidenceUnitConflicts(input: readonly GamingEvidenceUnit[]): GamingEvidenceUnit[] {
  // Two independently bounded strategies may exceed the final document cap.
  // Compare their full bounded union before selecting a prefix so an omitted
  // trailing assertion cannot hide a conflict with an accepted record.
  const limit = GAMING_STRUCTURAL_EVIDENCE_LIMITS.units;
  if (input.length > limit * 2) return [];
  const units = [...readGamingEvidenceUnits(input.slice(0, limit)), ...readGamingEvidenceUnits(input.slice(limit))];
  const conflicts = new Set((['location', 'statistic', 'patch_change'] as const).flatMap(claim => [...conflictingUnits(units, claim)]));
  return units.map(unit => conflicts.has(unit) ? { ...unit, integrity: { status: 'ambiguous' as const,
    reasons: [...new Set([...unit.integrity.reasons, 'contradictory_structural_records'])].slice(0, 16) } } : unit);
}

/** One record must support a tuple. Extraction, authority, applicability and consent stay separate decisions. */
export function assessGamingStructuralUsability(input: {
  units?: readonly GamingEvidenceUnit[]; prompt?: string; game?: string; mode?: 'guide' | 'build' | 'meta';
}): GamingStructuralUsability {
  const units = readGamingEvidenceUnits(input.units);
  const usable = units.filter(intact);
  const claimShape = shape(input, units);
  const terms = input.prompt ? buildGamingRetrievalTerms({ prompt: input.prompt, game: input.game }).focusTerms : [];
  const requestedValues = terms.filter(term => !REQUEST_FORMAT_TERMS.has(term));
  const request = normal(input.prompt ?? '');
  // Known value anchors identify requested entities, not just a row with the same body/resource elsewhere.
  const anchored = requestedFieldBindings(input.prompt ?? '', claimShape);
  // Punctuation inside identifiers is substantive. Tokens from different fields
  // must not manufacture T-1 from T-2 plus a body's unrelated numeric suffix.
  const requestedIdentifiers = [...request.matchAll(/[\p{L}\p{N}]+(?:[-.][\p{L}\p{N}]+)+/gu)].map(match => match[0]).slice(0, 32);
  for (const unit of units) for (const field of unit.fields) {
    const key = fieldKey(field.label);
    const value = normal(field.value);
    if (['system', 'body', 'site', 'resource', 'item', 'stat', 'mechanic', 'build'].includes(key)
      && value.length >= 2 && mentionsValue(request, value)) {
      const values = anchored.get(key) ?? new Set<string>(); values.add(value); anchored.set(key, values);
    }
  }
  const candidates = usable.map(unit => {
    const fields = new Map(unit.fields.map(field => [fieldKey(field.label), field.value]));
    const missing = requiredFields(claimShape, fields).filter(key => !fields.has(key));
    const sourceValues = unit.fields.map(field => field.value).join(' ');
    const sourceTokens = new Set(gamingLexicalTokens(sourceValues));
    const hasValueAnchor = claimShape === 'none' ? terms.some(term => sourceTokens.has(term))
      : requestedValues.length > 0 && requestedValues.every(term => sourceTokens.has(term))
        && requestedIdentifiers.every(value => unit.fields.some(field => mentionsValue(normal(field.value), value)));
    const sameScope = [...anchored].every(([key, values]) => values.size === 1 && values.has(normal(fields.get(key) ?? '')));
    const qualifierText = [sourceValues, ...unit.fields.map(field => field.label), ...(unit.context.qualifiers ?? []),
      unit.context.heading ?? '', unit.context.caption ?? '', unit.context.attribution ?? ''].join(' ');
    const qualified = /\b(?:unconfirmed|example only|retracted|superseded)\b/iu.test(qualifierText)
      || claimShape === 'location' && /\b(?:not\s+\S+|depleted|old patch|no longer available|correction)\b/iu.test(qualifierText);
    const relevant = terms.length > 0 && hasValueAnchor && gamingTermCoverage(unit.text, terms) >= 0.25;
    return { unit, missing, relevant, sameScope, qualified };
  });
  const conflicts = conflictingUnits(units, claimShape);
  const contradictory = (unit: GamingEvidenceUnit) => conflicts.has(unit);
  const supporting = candidates.filter(item => !item.missing.length && item.relevant && item.sameScope && !item.qualified && !contradictory(item.unit));
  const nearest = candidates.filter(item => item.relevant && item.sameScope).sort((a, b) => a.missing.length - b.missing.length)[0];
  const missingFields = supporting.length || claimShape === 'none' ? []
    : nearest?.missing.length ? nearest.missing : requiredFields(claimShape, new Map()).filter(key => !units.some(unit => unit.fields.some(field => fieldKey(field.label) === key)));
  return { hasIntactUsableUnit: usable.length > 0, claimShape,
    claimSupported: supporting.length > 0,
    usableUnitIds: usable.map(unit => unit.id), supportingUnitIds: supporting.map(item => item.unit.id), missingFields,
    reasonCodes: !usable.length ? ['NO_INTACT_STRUCTURAL_UNIT'] : supporting.length ? ['INTACT_RECORD_CLAIM_SUPPORTED']
      : [candidates.some(item => item.relevant && contradictory(item.unit)) ? 'CONTRADICTORY_STRUCTURAL_RECORDS'
        : candidates.some(item => item.qualified) ? 'QUALIFIED_RECORD_NOT_AFFIRMATIVE' : missingFields.length ? 'STRUCTURAL_CLAIM_FIELDS_MISSING' : 'QUESTION_COVERAGE_INSUFFICIENT'] };
}
