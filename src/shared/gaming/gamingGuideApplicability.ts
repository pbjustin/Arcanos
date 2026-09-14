import { normalizeGamingGameIdentity } from './gamingGameIdentity.js';
import type { GamingCurrentnessEvidenceShape } from './gamingCurrentnessAdapters.js';

/** Minimal structural contract keeps the applicability comparator independent of policy orchestration. */
interface GamingApplicabilityEvidence extends GamingCurrentnessEvidenceShape {
  category: string;
  metadataConfidence: 'unknown' | 'content_extracted';
  baselineForPatches?: string[];
  baselineForBuilds?: string[];
  supersedesPatches?: string[];
  supersedesBuilds?: string[];
  mechanicValues?: Record<string, string>;
}

export type GamingGuideApplicabilityStatus = 'verified_current' | 'partially_verified' | 'stale' | 'conflicting' | 'unverified';
export interface GamingGuideApplicability {
  evidenceId: string;
  status: GamingGuideApplicabilityStatus;
  reasons: string[];
  effectivePatch?: string;
  effectiveBuild?: string;
}

const normalized = (value: string): string => value.normalize('NFKC').trim().toLowerCase();
const same = (left?: string, right?: string): boolean => Boolean(left && right && normalized(left) === normalized(right));
const includes = (values: readonly string[] | undefined, value: string | undefined): boolean => Boolean(value && values?.some(item => same(item, value)));

/** Authority records contribute currentness; they are not complete gameplay recommendations. */
export function isGamingGameplayFreshnessEvidence(evidence: GamingApplicabilityEvidence): boolean {
  return !['current_index', 'live_status'].includes(evidence.currentness)
    && !['official_updates', 'official_status'].includes(evidence.category);
}

/**
 * Compare explicit acquired assertions only. Version IDs remain opaque here:
 * publication order, fetch time, and silence about a mechanic cannot extend a guide.
 * The caller establishes currentness independently before requesting this comparison.
 */
export function evaluateGamingGuideApplicability(input: {
  guide: GamingApplicabilityEvidence;
  game: string;
  edition?: string;
  platform?: string;
  region?: string;
  currentness?: GamingApplicabilityEvidence;
  officialEvidence?: readonly GamingApplicabilityEvidence[];
  now: Date;
}): GamingGuideApplicability {
  const { guide, currentness } = input;
  const patch = currentness?.currentPatch;
  const build = currentness?.currentBuild;
  const result = (status: GamingGuideApplicabilityStatus, ...reasons: string[]): GamingGuideApplicability => ({
    evidenceId: guide.id, status, reasons: reasons.slice(0, 8),
    ...(patch ? { effectivePatch: patch } : {}), ...(build ? { effectiveBuild: build } : {})
  });
  if (normalizeGamingGameIdentity(guide.game) !== normalizeGamingGameIdentity(input.game)) return result('conflicting', 'GAME_MISMATCH');
  if (guide.metadataConflict) return result('conflicting', 'CONTRADICTORY_SOURCE_METADATA');
  if (guide.metadataUnverified || guide.metadataConfidence !== 'content_extracted') return result('unverified', 'APPLICABILITY_METADATA_UNVERIFIED');
  if ((input.edition && !same(guide.edition, input.edition)) || (!input.edition && guide.edition)) return result('unverified', 'EDITION_UNVERIFIED_OR_MISMATCH');
  for (const [values, wanted, field] of [[guide.platforms, input.platform, 'PLATFORM'], [guide.regions, input.region, 'REGION']] as const) {
    if (values?.length && !includes(values, 'all') && !includes(values, wanted)) return result(wanted ? 'conflicting' : 'unverified', `${field}_UNVERIFIED_OR_MISMATCH`);
    if (wanted && !values?.length) return result('unverified', `${field}_UNVERIFIED_OR_MISMATCH`);
  }
  for (const value of [guide.effectiveFrom, guide.effectiveUntil, guide.publishedAt]) {
    if (value && !Number.isFinite(Date.parse(value))) return result('unverified', 'APPLICABILITY_METADATA_UNVERIFIED');
  }
  if ([guide.effectiveFrom, guide.publishedAt].some(value => value && Date.parse(value) > input.now.getTime())) return result('unverified', 'NOT_YET_EFFECTIVE');
  if (guide.effectiveUntil && Date.parse(guide.effectiveUntil) <= input.now.getTime()) return result('stale', 'NO_LONGER_EFFECTIVE');
  if (!currentness || currentness.authority !== 'official' || currentness.currentness !== 'current_index'
    || (currentness.currentnessMetadata && currentness.currentnessMetadata.status !== 'verified')
    || (!patch && !currentness.currentSeason)) return result('unverified', 'CURRENT_OFFICIAL_INDEX_REQUIRED');

  const official = [currentness, ...(input.officialEvidence ?? []).filter(item => item.authority === 'official')].slice(0, 20);
  const sameMechanicChanged = official.some(item => Object.entries(guide.mechanicValues ?? {}).slice(0, 16)
    .some(([key, value]) => item.mechanicValues?.[key] !== undefined && item.mechanicValues[key] !== value));
  if (sameMechanicChanged) return result('stale', 'CURRENT_UPDATE_CHANGES_GUIDE_MECHANIC');
  const patchMatch = !patch || same(guide.patch, patch);
  const patchBaseline = includes(guide.baselineForPatches, patch);
  const buildMatch = !build || same(guide.build, build);
  const buildBaseline = includes(guide.baselineForBuilds, build);
  if ((!patchMatch && !patchBaseline && official.some(item => includes(item.supersedesPatches, guide.patch)))
    || (!buildMatch && !buildBaseline && official.some(item => includes(item.supersedesBuilds, guide.build)))) return result('stale', 'GUIDE_VERSION_EXPLICITLY_SUPERSEDED');
  if (currentness.currentSeason && !same(guide.season, currentness.currentSeason)) return result('unverified', 'CURRENT_SEASON_COVERAGE_MISSING');
  if (!patchMatch && !patchBaseline) return result('unverified', guide.patch ? 'PATCH_MISMATCH' : 'GUIDE_PATCH_UNSPECIFIED');
  if (!buildMatch && !buildBaseline) return result('partially_verified', 'CURRENT_BUILD_COVERAGE_MISSING');
  if (!build && (guide.build || guide.baselineForBuilds?.length)) return result('partially_verified', 'CURRENT_BUILD_UNVERIFIED');
  return result('verified_current', patchBaseline || buildBaseline ? 'EXPLICIT_COMPATIBILITY_BASELINE' : 'GUIDE_MATCHES_CURRENT_VERSION');
}
