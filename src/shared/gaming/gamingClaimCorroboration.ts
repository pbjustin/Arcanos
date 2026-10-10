import { createHash } from 'node:crypto';
import type { GamingEvidenceUnit } from './gamingEvidenceUnits.js';
import { GAMING_HYBRID_V2_LIMITS } from './gamingHybridContract.js';
import { normalizeGamingEvidenceGameIdentity, normalizeGamingEditionIdentity } from './gamingGameIdentity.js';
import { gamingPlatformEvidenceMatchesRequest, normalizeGamingPlatformIdentity } from './gamingPlatformIdentity.js';
import { assessGamingStructuralUsability, readGamingEvidenceUnits, readGamingStructuralClaimAssertion } from './gamingStructuralEvidence.js';
import { filterGamingDocumentInstructions } from '@services/gamingDocumentExtraction.js';
import { GAMING_SOURCE_FAMILY_DATA, type GamingSourceFamilyRegistry } from './gamingSourceFamilyData.js';

export const GAMING_CLAIM_CORROBORATION_VERSION = 'gaming-claim-corroboration/v2';
const MAX_SOURCES = GAMING_HYBRID_V2_LIMITS.totalCandidateUrls
  + GAMING_HYBRID_V2_LIMITS.currentnessRounds * GAMING_HYBRID_V2_LIMITS.candidates + 8;
const MAX_CLAIMS = 128;
const MAX_REFS = 8;
const normalized = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9._:-]{1,240}$/u.test(value);

/** Presentation headings, captions, bylines and column order cannot turn copied
 * parser-owned records into independent reports. Preserve every field and local
 * qualifier; acquisition provenance and scope are checked separately below. */
function parserOwnedRecordFingerprint(unit: GamingEvidenceUnit): string {
  return hash({ fields: unit.fields.map(field => JSON.stringify([normalized(field.label), normalized(field.value)])).sort(),
    qualifiers: (unit.context.qualifiers ?? []).map(normalized).sort() });
}

export interface GamingClaimCorroborationSource {
  sourceId: string;
  sourceUrl: string;
  game?: string;
  edition?: string;
  patch?: string;
  platforms?: readonly string[];
  /** Backend assessment facts only; candidate/user hints must never populate these. */
  identityVerified?: boolean;
  applicabilityVerified?: boolean;
  evidenceUnits?: readonly GamingEvidenceUnit[];
}
export type GamingClaimCorroborationStatus = 'independently_corroborated' | 'single_source' | 'conflicting' | 'unverified';
export interface GamingClaimCorroborationSummary {
  policyVersion: typeof GAMING_CLAIM_CORROBORATION_VERSION;
  familyRegistryVersion: string;
  familyRegistryHash: string;
  status: 'evaluated' | 'unverified';
  reasonCodes: string[];
  claims: Array<{
    claimId: string;
    kind: 'location' | 'statistic' | 'patch_change' | 'build';
    status: GamingClaimCorroborationStatus;
    sourceIds: string[];
    evidenceUnitIds: string[];
    reviewedIndependentFamilyCount: number;
  }>;
}

function safeRegistry(registry: GamingSourceFamilyRegistry): boolean {
  return /^[a-zA-Z0-9._/-]{1,80}$/u.test(registry.version) && Array.isArray(registry.families)
    && registry.families.length <= 64 && registry.families.every(family => safeId(family.id)
      && typeof family.includeSubdomains === 'boolean' && Array.isArray(family.hosts) && family.hosts.length > 0 && family.hosts.length <= 32
      && family.hosts.every((host: string) => /^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?)+$/u.test(host) && host.length <= 253)
      && /^\d{4}-\d{2}-\d{2}$/u.test(family.provenance?.reviewedAt ?? '')
      && Array.isArray(family.provenance?.references) && family.provenance.references.length > 0 && family.provenance.references.length <= 4
      && family.provenance.references.every((reference: string) => {
        try { const url = new URL(reference); return reference.length <= 512 && url.protocol === 'https:' && !url.username && !url.password; }
        catch { return false; }
      })) && new Set(registry.families.map(family => family.id)).size === registry.families.length;
}

/** Unknown hosts remain grouped by hostname, with no reviewed independence credit. */
function sourceFamily(sourceUrl: string, registry: GamingSourceFamilyRegistry): { key: string; reviewed: boolean } | undefined {
  try {
    const url = new URL(sourceUrl);
    if (sourceUrl.length > 2_048 || url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443') return undefined;
    const host = url.hostname.toLowerCase();
    const matches = registry.families.filter(family => family.hosts.some(candidate => host === candidate
      || family.includeSubdomains && host.endsWith(`.${candidate}`)));
    return matches.length === 1 ? { key: `reviewed:${matches[0].id}`, reviewed: true }
      : { key: `unknown:${host}`, reviewed: false };
  } catch { return undefined; }
}

/** Bounded optional source-report summary. This neither establishes in-game
 * observation nor changes CLEAR conflict, provenance, freshness or security gates.
 * Prose and unestablished source ownership never manufacture corroboration. */
export function assessGamingClaimCorroboration(input: {
  game: string;
  edition?: string;
  platform?: string;
  requestedVersion?: string;
  prompt?: string;
  mode?: 'guide' | 'build' | 'meta';
  sources: readonly GamingClaimCorroborationSource[];
  /** Server-owned reviewed data seam; no public candidate metadata enters this registry. */
  familyRegistry?: GamingSourceFamilyRegistry;
}): GamingClaimCorroborationSummary {
  const registry = input.familyRegistry ?? GAMING_SOURCE_FAMILY_DATA;
  const validRegistry = safeRegistry(registry);
  const base: Pick<GamingClaimCorroborationSummary, 'policyVersion' | 'familyRegistryVersion' | 'familyRegistryHash'> = { policyVersion: GAMING_CLAIM_CORROBORATION_VERSION,
    familyRegistryVersion: validRegistry ? registry.version : 'unverified', familyRegistryHash: validRegistry ? hash(registry) : hash('unverified') };
  const unavailable = (reason: string): GamingClaimCorroborationSummary => ({ ...base, status: 'unverified', reasonCodes: [reason], claims: [] });
  if (!validRegistry) return unavailable('CORROBORATION_FAMILY_REGISTRY_INVALID');
  if (input.sources.length > MAX_SOURCES) return unavailable('CORROBORATION_BUDGET_EXCEEDED');
  if (!input.game || input.game.length > 120 || (input.prompt?.length ?? 0) > 8_000) return unavailable('CORROBORATION_SCOPE_UNVERIFIED');
  const sources = new Map<string, string>();
  type Report = { sourceId: string; unitId: string; value: string; recordHash: string;
    supported: boolean; family: { key: string; reviewed: boolean } };
  const claims = new Map<string, { kind: GamingClaimCorroborationSummary['claims'][number]['kind']; reports: Report[] }>();
  const reasons = new Set<string>();
  for (const source of input.sources) {
    const family = sourceFamily(source.sourceUrl, registry);
    if (!safeId(source.sourceId) || !family) return unavailable('CORROBORATION_SOURCE_PROVENANCE_INVALID');
    const units = readGamingEvidenceUnits(source.evidenceUnits ?? [], source.sourceUrl);
    if (units.length !== (source.evidenceUnits?.length ?? 0)) return unavailable('CORROBORATION_STRUCTURAL_PROVENANCE_INVALID');
    const sourceBinding = hash([source.sourceUrl, source.game, source.edition, source.patch, source.platforms,
      source.identityVerified, source.applicabilityVerified, units]);
    if (sources.has(source.sourceId)) {
      if (sources.get(source.sourceId) !== sourceBinding) return unavailable('CORROBORATION_SOURCE_IDENTITY_CONFLICT');
      continue;
    }
    sources.set(source.sourceId, sourceBinding);
    for (const unit of units) {
      const assertion = readGamingStructuralClaimAssertion(unit);
      if (!assertion || !safeId(unit.id)) continue;
      const game = assertion.game ?? source.game;
      const edition = assertion.edition ?? source.edition;
      const patch = assertion.patch ?? source.patch;
      const platformScope = [...new Set(source.platforms?.map(normalizeGamingPlatformIdentity) ?? [])].sort();
      const sourceScope = [normalizeGamingEvidenceGameIdentity(game ?? ''), normalizeGamingEditionIdentity(edition ?? ''),
        normalized(patch ?? ''), platformScope];
      const identity = hash([assertion.kind, sourceScope, assertion.identity]);
      if (!claims.has(identity) && claims.size >= MAX_CLAIMS) return unavailable('CORROBORATION_BUDGET_EXCEEDED');
      const entry = claims.get(identity) ?? { kind: assertion.kind, reports: [] };
      const gameEstablished = Boolean(game && source.game && normalizeGamingEvidenceGameIdentity(game) === normalizeGamingEvidenceGameIdentity(input.game)
        && normalizeGamingEvidenceGameIdentity(source.game) === normalizeGamingEvidenceGameIdentity(input.game));
      const editionEstablished = Boolean(edition && (!source.edition || normalizeGamingEditionIdentity(edition) === normalizeGamingEditionIdentity(source.edition))
        && (!input.edition || normalizeGamingEditionIdentity(edition) === normalizeGamingEditionIdentity(input.edition)));
      const patchEstablished = (!source.patch || !assertion.patch || normalized(source.patch) === normalized(assertion.patch))
        && (!input.requestedVersion || Boolean(patch && normalized(patch) === normalized(input.requestedVersion)));
      const sourceSupported = source.identityVerified === true && source.applicabilityVerified === true
        && gameEstablished && editionEstablished && patchEstablished
        && gamingPlatformEvidenceMatchesRequest(source.platforms, input.platform);
      const support = assessGamingStructuralUsability({ units: [unit], ...input });
      const safeText = filterGamingDocumentInstructions(unit.text) === unit.text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
      const supported = sourceSupported && safeText && support.claimSupported;
      if (!supported) reasons.add('CLAIM_SCOPE_OR_SUPPORT_UNVERIFIED');
      entry.reports.push({ sourceId: source.sourceId, unitId: unit.id, value: hash(assertion.value),
        recordHash: parserOwnedRecordFingerprint(unit), supported, family });
      claims.set(identity, entry);
    }
  }
  const summaries: GamingClaimCorroborationSummary['claims'] = [];
  for (const [claimId, entry] of claims) {
    const supported = entry.reports.filter(report => report.supported);
    const values = new Set(supported.map(report => report.value));
    const recordFamilies = new Map<string, Set<string>>();
    for (const report of supported) {
      const families = recordFamilies.get(report.recordHash) ?? new Set<string>();
      families.add(report.family.key); recordFamilies.set(report.recordHash, families);
    }
    // Copies connect publication lineages transitively. An unknown family may
    // connect copies, but cannot create an additional independent family.
    const parents = new Map(supported.map(report => [report.family.key, report.family.key]));
    const root = (family: string): string => {
      let current = family;
      while (parents.get(current) !== current) current = parents.get(current)!;
      return current;
    };
    for (const families of recordFamilies.values()) {
      const first = [...families][0];
      for (const family of families) parents.set(root(family), root(first));
    }
    const independentFamilies = new Set(supported.filter(report => report.family.reviewed).map(report => root(report.family.key)));
    if (supported.length > new Set(supported.map(report => report.recordHash)).size) reasons.add('DUPLICATED_CLAIM_REPORTS');
    const status = values.size > 1 ? 'conflicting' : !supported.length ? 'unverified'
      : independentFamilies.size > 1 ? 'independently_corroborated' : 'single_source';
    summaries.push({ claimId, kind: entry.kind, status,
      sourceIds: [...new Set(entry.reports.map(report => report.sourceId))].sort().slice(0, MAX_REFS),
      evidenceUnitIds: [...new Set(entry.reports.map(report => report.unitId))].sort().slice(0, MAX_REFS),
      reviewedIndependentFamilyCount: independentFamilies.size });
  }
  return { ...base, status: summaries.length ? 'evaluated' : 'unverified',
    reasonCodes: summaries.length ? [...reasons].slice(0, 8) : ['STRUCTURED_CLAIMS_UNVERIFIED'], claims: summaries };
}
