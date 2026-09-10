import { createHash } from 'node:crypto';
import { z } from 'zod';
import { classifyGamingQuestionFreshness } from './gamingFreshnessCore.js';

export const GAMING_CLEAR_VERSION = 'gaming-clear/v1' as const;
export const GAMING_CLEAR_POLICY_VERSION = 'gaming-clear-policy/v1' as const;
export const GAMING_CLEAR_DIMENSIONS = ['clarity', 'leverage', 'efficiency', 'alignment', 'resilience'] as const;
export type GamingClearDimension = typeof GAMING_CLEAR_DIMENSIONS[number];
export type GamingClearProfile = 'source' | 'evidence' | 'answer';
export type GamingClearQuestionProfile = 'walkthrough' | 'current_build' | 'patch_change' | 'live_status' | 'explanation';
export type GamingClearSourceRole = 'gameplay_guide' | 'build_analysis' | 'patch_authority' | 'currentness_index' | 'live_status' | 'community_observation' | 'corroboration';

/** The single executable rubric. Profiles change the subject, never the acronym. */
export const GAMING_CLEAR_RUBRIC = Object.freeze({
  clarity: Object.freeze({ letter: 'C', name: 'Clarity', definition: 'Is the information precise and understandable enough to interpret correctly?',
    criteria: 'Identify game and topic; use intelligible steps, quantities and prerequisites; separate observations, recommendations and assumptions; state material uncertainty. Polished writing is not truth. Irrelevant missing platform or patch fields are not defects.' }),
  leverage: Object.freeze({ letter: 'L', name: 'Leverage', definition: 'How much does the material contribute to the player\'s actual task?',
    criteria: 'Evaluate useful next steps, tactics, tradeoffs, prerequisites and balance evidence against the intended source role. Prefer complementary evidence to generic filler. Patch authority can verify a change without proving a complete build.' }),
  efficiency: Object.freeze({ letter: 'E', name: 'Efficiency', definition: 'Can the material be used proportionately without unnecessary noise or cost?',
    criteria: 'Evaluate relevant excerpts, usable structure, duplicate passages, navigation noise, bounded retrieval, calls and requested answer depth. Do not punish a long guide for length alone. Efficiency cannot compensate for unsupported claims.' }),
  alignment: Object.freeze({ letter: 'A', name: 'Alignment', definition: 'Does the material apply to this request and its meaningful constraints?',
    criteria: 'Check game, meaningful edition, topic, player checkpoint, difficulty, platform, region, historical or current patch, season, spoiler preference and depth where relevant. Explicit incompatibility blocks; missing facts do not establish a match.' }),
  resilience: Object.freeze({ letter: 'R', name: 'Resilience', definition: 'How well does the information remain dependable under uncertainty or change?',
    criteria: 'Require traceable provenance and claim-appropriate reliability. Consider independent corroboration, contradictions, superseding changes, partial extraction, undocumented behavior and uncertainty. Official is not universally sufficient; community is not always false; fetched recently is not current. Injection remains a hard control.' })
});

const staticWeights = Object.freeze({ clarity: 0.25, leverage: 0.25, efficiency: 0.15, alignment: 0.25, resilience: 0.10 });
const currentWeights = Object.freeze({ clarity: 0.15, leverage: 0.20, efficiency: 0.10, alignment: 0.30, resilience: 0.25 });
export const GAMING_CLEAR_WEIGHTS: Readonly<Record<GamingClearQuestionProfile, Readonly<Record<GamingClearDimension, number>>>> = Object.freeze({
  walkthrough: staticWeights, explanation: staticWeights, current_build: currentWeights,
  patch_change: currentWeights, live_status: currentWeights
});
export const GAMING_CLEAR_THRESHOLDS = Object.freeze({
  transient: Object.freeze({ overall: 3.25, clarity: 3, alignment: 3.5, resilience: 3 }),
  durable: Object.freeze({ overall: 4, clarity: 3.5, alignment: 4, resilience: 3.5 }),
  evidence: Object.freeze({ overall: 3.5, clarity: 3, alignment: 4, resilience: 3 }),
  answer: Object.freeze({ overall: 4, clarity: 3.5, alignment: 4, resilience: 3.5 })
});
/** All other answer findings are material or unresolved; models cannot downgrade them. */
export const GAMING_CLEAR_NONBLOCKING_ANSWER_FINDINGS: readonly string[] = Object.freeze([
  'STYLE_CONCISION', 'STYLE_REPETITION', 'STYLE_PRESENTATION'
]);

const code = z.string().min(1).max(80).regex(/^[A-Z][A-Z0-9_]*$/u);
const reference = z.string().min(1).max(256);
const refs = z.array(reference).max(64);
const dimensionSchema = z.object({
  status: z.enum(['evaluated', 'unknown', 'not_applicable']),
  score: z.number().finite().min(0).max(5).nullable(),
  reasonCodes: z.array(code).max(8), evidenceRefs: refs,
  unresolvedFacts: z.array(code).max(4)
}).strict().superRefine((value, context) => {
  if ((value.status === 'evaluated') !== (value.score !== null)) context.addIssue({ code: 'custom', message: 'Only evaluated dimensions have a numeric score.' });
});
const dimensionsSchema = z.object({ clarity: dimensionSchema, leverage: dimensionSchema, efficiency: dimensionSchema,
  alignment: dimensionSchema, resilience: dimensionSchema }).strict();
const findingSchema = z.object({ code, severity: z.enum(['blocking', 'warning']), evidenceRefs: refs }).strict();
export type GamingClearDimensionScore = z.infer<typeof dimensionSchema>;
export type GamingClearDimensions = z.infer<typeof dimensionsSchema>;
export type GamingClearFinding = z.infer<typeof findingSchema>;
export type GamingClearGateStatus = 'verified' | 'unknown' | 'conflict' | 'not_applicable';
const gateSchema = z.enum(['verified', 'unknown', 'conflict', 'not_applicable']);
const gatesSchema = z.object({ identity: gateSchema, compatibility: gateSchema, claimSupport: gateSchema,
  freshness: gateSchema, provenance: gateSchema, security: gateSchema }).strict();
export type GamingClearGates = z.infer<typeof gatesSchema>;
export type GamingClearAssessmentMethod = 'deterministic' | 'model_assisted' | 'mixed';
export type GamingClearAssessmentStatus = 'completed' | 'unavailable' | 'not_run';
export interface GamingClearAssessment {
  rubricVersion: typeof GAMING_CLEAR_VERSION;
  profile: GamingClearProfile;
  policyProfile: string;
  sourceRole?: GamingClearSourceRole;
  subjectId: string;
  subjectHash: string;
  contextFingerprint: string;
  assessmentMethod: GamingClearAssessmentMethod;
  assessmentStatus: GamingClearAssessmentStatus;
  dimensionScores: GamingClearDimensions;
  gates: GamingClearGates;
  overall: number | null;
  findings: GamingClearFinding[];
  blockingFindings: GamingClearFinding[];
  decision: 'accept' | 'partial' | 'reject' | 'clarify' | 'unavailable';
  /** Quality only; never a storage permission or source-use grant. */
  qualityEligible: boolean;
  evaluatedAt: string;
}
export type GamingClearResult = GamingClearAssessment;

export function gamingClearHash(value: unknown): string {
  const stable = (item: unknown): unknown => Array.isArray(item) ? item.map(stable)
    : item && typeof item === 'object' && !(item instanceof Date)
      ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, stable(child)])) : item;
  return createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');
}
export function gamingClearContextFingerprint(value: unknown): string {
  return gamingClearHash({ rubricVersion: GAMING_CLEAR_VERSION, policyVersion: GAMING_CLEAR_POLICY_VERSION, context: value });
}
export function classifyGamingClearQuestion(input: { prompt: string; mode?: string; requestedVersion?: string }): GamingClearQuestionProfile {
  const freshness = classifyGamingQuestionFreshness(input);
  if (freshness === 'live_status') return 'live_status';
  if (freshness !== 'stable') return /\b(?:patch|hotfix|nerf|buff|change|changed)\b/iu.test(input.prompt) && !/\bbuild\b/iu.test(input.prompt) ? 'patch_change' : 'current_build';
  return /\b(?:explain|why|how does|what is)\b/iu.test(input.prompt) ? 'explanation' : 'walkthrough';
}

/** Strict model projection: no model-selected policy, decision, overall, gate or freeform reasoning. */
export function parseGamingClearModelAssessment(value: unknown, allowedEvidenceRefs: readonly string[]): { dimensions: GamingClearDimensions; findings: GamingClearFinding[] } | null {
  const parsed = z.object({ dimensions: dimensionsSchema, findings: z.array(findingSchema).max(24) }).strict().safeParse(value);
  if (!parsed.success) return null;
  const allowed = new Set(allowedEvidenceRefs);
  const cited = [...Object.values(parsed.data.dimensions).flatMap(dimension => dimension.evidenceRefs), ...parsed.data.findings.flatMap(finding => finding.evidenceRefs)];
  // Every dimension is required by v1: N/A cannot remove a low-scoring dimension or a currentness requirement.
  if (cited.some(id => !allowed.has(id)) || Object.values(parsed.data.dimensions).some(dimension => dimension.status === 'not_applicable'
    || (dimension.status === 'evaluated' && dimension.score! > 0 && dimension.evidenceRefs.length === 0))) return null;
  return parsed.data;
}

/** Validates persisted audit provenance; reuse still requires caller/content/context binding. */
export function parseGamingClearAssessment(value: unknown): GamingClearAssessment | null {
  const parsed = z.object({
    rubricVersion: z.literal(GAMING_CLEAR_VERSION), profile: z.enum(['source', 'evidence', 'answer']),
    policyProfile: z.string().max(100), sourceRole: z.enum(['gameplay_guide', 'build_analysis', 'patch_authority', 'currentness_index', 'live_status', 'community_observation', 'corroboration']).optional(),
    subjectId: reference, subjectHash: z.string().regex(/^[a-f0-9]{64}$/u), contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    assessmentMethod: z.enum(['deterministic', 'model_assisted', 'mixed']), assessmentStatus: z.enum(['completed', 'unavailable', 'not_run']),
    dimensionScores: dimensionsSchema, gates: gatesSchema, overall: z.number().finite().min(0).max(5).nullable(),
    findings: z.array(findingSchema).max(32), blockingFindings: z.array(findingSchema).max(32),
    decision: z.enum(['accept', 'partial', 'reject', 'clarify', 'unavailable']), qualityEligible: z.boolean(), evaluatedAt: z.string().datetime()
  }).strict().safeParse(value);
  if (!parsed.success) return null;
  const result = parsed.data;
  const profile = result.policyProfile.split(':');
  if (profile.length !== 3 || profile[0] !== GAMING_CLEAR_POLICY_VERSION || profile[2] !== result.profile
    || !Object.hasOwn(GAMING_CLEAR_WEIGHTS, profile[1])) return null;
  try {
    const referenceIds = [...new Set([...Object.values(result.dimensionScores).flatMap(dimension => dimension.evidenceRefs), ...result.findings.flatMap(finding => finding.evidenceRefs)])];
    const computed = createGamingClearAssessment({ ...result, questionProfile: profile[1] as GamingClearQuestionProfile,
      evidenceRefs: referenceIds, dimensions: result.dimensionScores, findings: result.findings });
    return gamingClearHash(result) === gamingClearHash(computed) ? computed : null;
  } catch { return null; }
}

export interface GamingClearAssessmentInput {
  profile: GamingClearProfile;
  questionProfile: GamingClearQuestionProfile;
  sourceRole?: GamingClearSourceRole;
  subjectId: string;
  subjectHash: string;
  contextFingerprint: string;
  evidenceRefs: readonly string[];
  gates: GamingClearGates;
  dimensions: GamingClearDimensions;
  findings?: GamingClearFinding[];
  assessmentMethod?: GamingClearAssessmentMethod;
  assessmentStatus?: GamingClearAssessmentStatus;
  evaluatedAt?: string;
}

export function createGamingClearAssessment(input: GamingClearAssessmentInput): GamingClearAssessment {
  const identity = z.object({
    profile: z.enum(['source', 'evidence', 'answer']), questionProfile: z.enum(['walkthrough', 'current_build', 'patch_change', 'live_status', 'explanation']),
    sourceRole: z.enum(['gameplay_guide', 'build_analysis', 'patch_authority', 'currentness_index', 'live_status', 'community_observation', 'corroboration']).optional(),
    subjectId: reference, subjectHash: z.string().regex(/^[a-f0-9]{64}$/u), contextFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
    assessmentMethod: z.enum(['deterministic', 'model_assisted', 'mixed']).default('deterministic'),
    assessmentStatus: z.enum(['completed', 'unavailable', 'not_run']).default('completed'), evaluatedAt: z.string().datetime().optional()
  }).parse(input);
  const gates = gatesSchema.parse(input.gates);
  refs.parse(input.evidenceRefs);
  const projection = parseGamingClearModelAssessment({ dimensions: input.dimensions, findings: input.findings ?? [] }, input.evidenceRefs);
  if (!projection) throw new TypeError('Invalid Gaming CLEAR assessment projection');
  const findings = projection.findings.map(finding => input.profile === 'answer'
    && identity.assessmentStatus === 'completed' && !GAMING_CLEAR_NONBLOCKING_ANSWER_FINDINGS.includes(finding.code)
    ? { ...finding, severity: 'blocking' as const } : finding);
  const append = (findingCode: string) => {
    const index = findings.findIndex(finding => finding.code === findingCode);
    if (index < 0) findings.push({ code: findingCode, severity: 'blocking', evidenceRefs: [] });
    else findings[index] = { ...findings[index], severity: 'blocking' };
  };
  const supportingSource = input.profile === 'source' && ['patch_authority', 'currentness_index', 'corroboration'].includes(input.sourceRole ?? '');
  const freshnessRequired = !['walkthrough', 'explanation'].includes(input.questionProfile) && !supportingSource;
  for (const [name, state] of Object.entries(gates)) {
    if (state === 'conflict') append(`${name.toUpperCase()}_CONFLICT`);
    if (state === 'not_applicable' && (name !== 'freshness' || freshnessRequired)) append(`${name.toUpperCase()}_REQUIRED`);
  }
  const requiredUnknown = Object.entries(gates).filter(([name, state]) => state === 'unknown' && (name !== 'freshness' || freshnessRequired));
  for (const [name] of requiredUnknown) append(`${name.toUpperCase()}_UNVERIFIED`);
  const status = identity.assessmentStatus;
  const dimensionScores = status === 'completed' ? projection.dimensions : Object.fromEntries(GAMING_CLEAR_DIMENSIONS.map(name => [name, {
    status: 'unknown', score: null, reasonCodes: [status === 'not_run' ? 'AUDIT_NOT_RUN' : 'AUDIT_UNAVAILABLE'], evidenceRefs: [], unresolvedFacts: []
  }])) as unknown as GamingClearDimensions;
  const allEvaluated = Object.values(dimensionScores).every(dimension => dimension.status === 'evaluated');
  const overall = allEvaluated ? GAMING_CLEAR_DIMENSIONS.reduce((sum, name) => sum + dimensionScores[name].score! * (GAMING_CLEAR_WEIGHTS[input.questionProfile][name] * 100), 0) / 100 : null;
  const threshold = GAMING_CLEAR_THRESHOLDS[input.profile === 'source' ? 'transient' : input.profile];
  const meets = (floors: typeof threshold) => overall !== null && overall >= floors.overall
    && dimensionScores.clarity.score! >= floors.clarity && dimensionScores.alignment.score! >= floors.alignment
    && dimensionScores.resilience.score! >= Math.max(floors.resilience, freshnessRequired ? 3.5 : 0);
  if (status === 'completed' && !allEvaluated) append('DIMENSION_UNEVALUATED');
  if (status === 'completed' && input.profile === 'answer'
    && Object.values(dimensionScores).some(dimension => dimension.unresolvedFacts.length > 0)) append('MATERIAL_FACT_UNRESOLVED');
  if (status === 'completed' && allEvaluated && !meets(threshold)) append('PROFILE_FLOOR_NOT_MET');
  const blockingFindings = findings.filter(finding => finding.severity === 'blocking');
  const hardConflict = Object.values(gates).some(state => state === 'conflict');
  const unknownOnly = blockingFindings.every(finding => /(?:_UNVERIFIED|DIMENSION_UNEVALUATED)$/u.test(finding.code));
  const decision = status !== 'completed' ? 'unavailable' : hardConflict ? 'reject'
    : blockingFindings.length === 0 ? 'accept'
      : unknownOnly ? (input.profile === 'source' && requiredUnknown.every(([name]) => name === 'freshness') ? 'partial' : 'clarify') : 'reject';
  return {
    rubricVersion: GAMING_CLEAR_VERSION, profile: identity.profile,
    policyProfile: `${GAMING_CLEAR_POLICY_VERSION}:${identity.questionProfile}:${identity.profile}`,
    ...(identity.sourceRole ? { sourceRole: identity.sourceRole } : {}), subjectId: identity.subjectId,
    subjectHash: identity.subjectHash, contextFingerprint: identity.contextFingerprint,
    assessmentMethod: identity.assessmentMethod, assessmentStatus: status, dimensionScores, gates, overall,
    findings: findings.slice(0, 32), blockingFindings: blockingFindings.slice(0, 32), decision,
    qualityEligible: input.profile === 'source' && decision === 'accept' && meets(GAMING_CLEAR_THRESHOLDS.durable),
    evaluatedAt: identity.evaluatedAt ?? new Date().toISOString()
  };
}
