import { GAMING_EVIDENCE_UNIT_POLICY_VERSION, type GamingEvidenceExtractionInput,
  type GamingEvidenceUnit, type GamingStructureDiagnostics } from '@shared/gaming/gamingEvidenceUnits.js';
import { filterGamingDocumentInstructions } from './gamingDocumentExtraction.js';
import { extractGamingHtmlEvidence } from './gamingHtmlEvidence.js';
import { extractGamingJsonEvidence } from './gamingJsonEvidence.js';
import { markGamingEvidenceUnitConflicts } from '@shared/gaming/gamingStructuralEvidence.js';

const SOURCE_USE_RESTRICTION = /\b(?:no (?:automated|machine) (?:access|use)|automated (?:access|use) (?:is )?prohibited|do not (?:store|redistribute) (?:this|our) content)\b/iu;
const normalize = (value: string) => value.normalize('NFKC').replace(/\s+/gu, ' ').trim();

/** One accepted response; no network, query, model or publisher trust enters extraction. */
export function extractGamingDocumentEvidence(input: GamingEvidenceExtractionInput & {
  receivedBytes?: number; acceptedBytes?: number;
}): { units: GamingEvidenceUnit[]; proseBody: string; instructionFiltered: boolean;
  sourceUseRestricted: boolean; diagnostics: GamingStructureDiagnostics } {
  const startedAt = Date.now();
  const html = extractGamingHtmlEvidence(input);
  const json = extractGamingJsonEvidence(input);
  const subreasons = [...new Set([...html.subreasons, ...json.subreasons])]
    .filter(reason => reason !== 'no_supported_structured_records' || !html.units.length && !json.units.length).slice(0, 16);
  if (!input.body.trim()) subreasons.push('empty_response');
  const units: GamingEvidenceUnit[] = [];
  const seen = new Set<string>();
  let outputChars = 0;
  let instructionFiltered = subreasons.some(reason => ['source_instruction_filtered', 'source_instructions_rejected',
    'instruction_or_sensitive_content_filtered'].includes(reason));
  let capped = false;
  const accessChallenge = subreasons.includes('access_challenge');
  for (const unit of markGamingEvidenceUnitConflicts(accessChallenge ? [] : [...html.units, ...json.units])) {
    // Labels/qualifiers and source values are checked together. Never turn a removed
    // instruction-bearing qualifier into an apparently complete affirmative record.
    if (filterGamingDocumentInstructions(unit.text) !== normalize(unit.text)) {
      instructionFiltered = true;
      continue;
    }
    const identity = JSON.stringify({ fields: unit.fields, context: unit.context, provenance: unit.provenance });
    if (seen.has(identity)) continue;
    if (units.length >= 2048 || outputChars + unit.text.length > 1_000_000) { capped = true; break; }
    seen.add(identity);
    units.push(unit);
    outputChars += unit.text.length;
  }
  if (capped && !subreasons.includes('extraction_budget_exhausted')) subreasons.push('extraction_budget_exhausted');
  // Inert JSON-only content is never indexed by falling back to its entire state blob.
  const proseBody = input.contentType === 'application/json' ? '' : html.proseBody ?? input.body;
  const sourceUseRestricted = SOURCE_USE_RESTRICTION.test(input.body.replace(/<[^>]*>/gu, ' '));
  const truncated = html.truncated || json.truncated || capped;
  return { units, proseBody, instructionFiltered, sourceUseRestricted, diagnostics: {
    policyVersion: GAMING_EVIDENCE_UNIT_POLICY_VERSION,
    strategies: [...new Set(['prose', ...html.attempts, ...json.attempts])].slice(0, 8),
    contentType: input.contentType || 'unknown',
    ...(input.receivedBytes === undefined ? {} : { receivedBytes: input.receivedBytes }),
    acceptedBytes: input.acceptedBytes ?? Buffer.byteLength(input.body, 'utf8'),
    rawChars: input.body.length, extractedChars: outputChars,
    unitKinds: [...new Set(units.map(unit => unit.kind))], selectedUnits: units.length,
    completeUnits: units.filter(unit => unit.integrity.status === 'complete').length,
    partialUnits: units.filter(unit => unit.integrity.status === 'partial').length,
    ambiguousUnits: units.filter(unit => unit.integrity.status === 'ambiguous').length,
    truncationStages: [...(input.transportTruncated ? ['transport'] : []), ...(truncated ? ['extraction'] : [])],
    subreasons, elapsedMs: Date.now() - startedAt,
    budgetOutcome: subreasons.includes('extraction_budget_exhausted') ? 'exhausted' : 'within_budget'
  } };
}
