import { z } from "zod";

export const GAMING_BUILD_RESOURCE_SCHEMA_VERSION = "1";

export const GAMING_BUILD_RESOURCE_HARD_LIMITS = Object.freeze({
  maxUrlChars: 16_384,
  maxEncodedPayloadChars: 65_536,
  maxPayloadCandidates: 16,
  maxDecodedBytes: 262_144,
  maxHtmlChars: 1_048_576,
  maxScripts: 32,
  maxScriptChars: 262_144,
  maxCumulativeScriptChars: 524_288,
  maxJsonDepth: 12,
  maxArrayLength: 256,
  maxFieldCount: 2_000,
  maxStringLength: 4_096,
  maxObjectKeys: 256,
  maxEquipmentEntries: 128,
  maxSkillEntries: 256,
  maxListEntries: 256,
  maxStatEntries: 256,
  maxTableRows: 256,
  maxTableCellsPerRow: 32,
  maxAdapters: 16,
  maxAdapterIdChars: 64,
  maxAdapterVersionChars: 64,
  maxExtractionMs: 1_000,
  maxAdapterCanHandleMs: 200,
  maxAdapterExtractMs: 500,
  maxCacheEntries: 100,
  cacheTtlMs: 15 * 60_000,
  maxPublicSnippetChars: 600,
  maxEvidenceChars: 8_000,
  maxSafePublicParamChars: 160,
  maxSafeShareCodeChars: 64,
  maxSafePathSegmentChars: 160,
  maxNumericValue: 1_000_000_000
} as const);

export const GAMING_RESOURCE_TYPES = [
  "article",
  "patch_notes",
  "wiki",
  "build_planner",
  "loadout",
  "skill_tree",
  "character_profile",
  "calculator",
  "unknown"
] as const;

export type GamingResourceType = typeof GAMING_RESOURCE_TYPES[number];

export const GAMING_EXTRACTION_QUALITIES = [
  "complete",
  "substantial",
  "partial",
  "metadata-only",
  "unusable"
] as const;

export type GamingExtractionQuality = typeof GAMING_EXTRACTION_QUALITIES[number];

export const GAMING_STRUCTURED_FAILURE_REASONS = [
  "STRUCTURED_RESOURCE_UNSUPPORTED",
  "STRUCTURED_PAYLOAD_MALFORMED",
  "STRUCTURED_PAYLOAD_TOO_LARGE",
  "STRUCTURED_PAYLOAD_DECODE_FAILED",
  "STRUCTURED_RESOURCE_PARTIAL",
  "STRUCTURED_RESOURCE_METADATA_ONLY",
  "STRUCTURED_RESOURCE_GAME_MISMATCH"
] as const;

export type GamingStructuredFailureReason = typeof GAMING_STRUCTURED_FAILURE_REASONS[number];

export const GAMING_EXTRACTION_STRATEGIES = [
  "url_payload",
  "embedded_state",
  "visible_html",
  "metadata",
  "adapter",
  "article",
  "none"
] as const;

export type GamingExtractionStrategy = typeof GAMING_EXTRACTION_STRATEGIES[number];

export interface NormalizedGamingBuild {
  game?: string;
  title?: string;
  role?: string;
  archetype?: string;
  activity?: string;
  patch?: string;
  character?: {
    class?: string;
    subclass?: string;
    specialization?: string;
    level?: number;
  };
  equipment?: Array<{
    slot?: string;
    name: string;
    category?: string;
    rarity?: string;
    upgrades?: string[];
    modifications?: string[];
    quantity?: number;
  }>;
  skills?: Array<{
    name: string;
    rank?: number;
    category?: string;
    modifiers?: string[];
  }>;
  stats?: Record<string, string | number>;
  rotation?: string[];
  talents?: string[];
  perks?: string[];
  traits?: string[];
  consumables?: string[];
  companions?: string[];
  utility?: string[];
  strengths?: string[];
  weaknesses?: string[];
  constraints?: string[];
  notes?: string[];
  source: {
    url: string;
    resourceType: GamingResourceType;
    extractor: string;
    confidence: number;
  };
}

export interface GamingPreparedResourceUrl {
  /** URL retained only for the existing SSRF-safe fetch layer and local payload parsing. */
  privateFetchUrl: string;
  /** Public citation URL with credentials, tracking, signatures, and encoded payloads removed. */
  publicUrl: string;
  canonicalPublicUrl: string;
  safeDisplayUrl: string;
  /** SHA-256 digest only; the source payload is never part of logs or public output. */
  payloadHash: string;
  payloadLength: number;
}

export interface GamingResourceMetadata {
  title?: string;
  description?: string;
  canonicalUrl?: string;
  openGraph?: Readonly<Record<string, string>>;
  jsonLd?: unknown;
  headings?: string | readonly string[];
  embeddedState?: unknown;
  scriptConfiguration?: readonly string[];
}

/**
 * Adapter input is data-only. It intentionally exposes no fetch/client/tool callback.
 * Adapters may inspect the already supplied URL/document data but cannot request another URL
 * through this interface.
 */
export interface GamingResourceInput {
  url: string;
  preparedUrl?: GamingPreparedResourceUrl;
  requestedGame?: string;
  prompt?: string;
  contentType?: string;
  html?: string;
  text?: string;
  metadata?: GamingResourceMetadata;
  signal?: AbortSignal;
}

export interface GamingResourceClassification {
  type: GamingResourceType;
  confidence: number;
  detectedGame?: string;
  gameConfidence: number;
  gameEvidence: string[];
  detectedTool?: string;
  extractionStrategy: GamingExtractionStrategy;
  reason: string;
  signals: string[];
}

export interface GamingBuildValidationResult {
  accepted: boolean;
  quality: GamingExtractionQuality;
  normalizedFieldCount: number;
  usefulFieldCount: number;
  categoryCount: number;
  equipmentCount: number;
  skillCount: number;
  statCount: number;
  issues: string[];
  failureReason?: GamingStructuredFailureReason;
}

export interface GamingBuildExtractionMetrics {
  payloadLength: number;
  payloadHash: string;
  decodedSize: number;
  normalizedFieldCount: number;
  equipmentCount: number;
  skillCount: number;
  statCount: number;
  extractionElapsedMs: number;
  adapterElapsedMs: number;
}

export interface GamingBuildResourceResult {
  publicUrl: string;
  safeDisplayUrl: string;
  classification: GamingResourceClassification;
  build: NormalizedGamingBuild | null;
  quality: GamingExtractionQuality;
  validation: GamingBuildValidationResult;
  adapterId: string;
  adapterVersion: string;
  extractionStrategy: GamingExtractionStrategy;
  evidenceText: string;
  publicSnippet: string;
  metrics: GamingBuildExtractionMetrics;
  cacheHit: boolean;
  failureReason?: GamingStructuredFailureReason;
}

export interface GamingBuildResourceAdapter {
  id: string;
  version?: string;
  canHandle(input: GamingResourceInput): Promise<number>;
  extract(input: GamingResourceInput): Promise<NormalizedGamingBuild | null>;
}

const boundedString = z.string().max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxStringLength);
const boundedStringArray = z.array(boundedString).max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxListEntries);
const boundedInteger = z.number()
  .int()
  .finite()
  .min(0)
  .max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxNumericValue);

export const GamingResourceTypeSchema = z.enum(GAMING_RESOURCE_TYPES);
export const GamingExtractionQualitySchema = z.enum(GAMING_EXTRACTION_QUALITIES);
export const GamingStructuredFailureReasonSchema = z.enum(GAMING_STRUCTURED_FAILURE_REASONS);

export const NormalizedGamingBuildSchema: z.ZodType<NormalizedGamingBuild> = z.object({
  game: boundedString.optional(),
  title: boundedString.optional(),
  role: boundedString.optional(),
  archetype: boundedString.optional(),
  activity: boundedString.optional(),
  patch: boundedString.optional(),
  character: z.object({
    class: boundedString.optional(),
    subclass: boundedString.optional(),
    specialization: boundedString.optional(),
    level: boundedInteger.optional()
  }).strict().optional(),
  equipment: z.array(z.object({
    slot: boundedString.optional(),
    name: boundedString,
    category: boundedString.optional(),
    rarity: boundedString.optional(),
    upgrades: boundedStringArray.optional(),
    modifications: boundedStringArray.optional(),
    quantity: boundedInteger.optional()
  }).strict()).max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxEquipmentEntries).optional(),
  skills: z.array(z.object({
    name: boundedString,
    rank: boundedInteger.optional(),
    category: boundedString.optional(),
    modifiers: boundedStringArray.optional()
  }).strict()).max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxSkillEntries).optional(),
  stats: z.record(z.union([
    boundedString,
    z.number().finite()
      .min(-GAMING_BUILD_RESOURCE_HARD_LIMITS.maxNumericValue)
      .max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxNumericValue)
  ])).superRefine((value, context) => {
    if (Object.keys(value).length > GAMING_BUILD_RESOURCE_HARD_LIMITS.maxStatEntries) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Too many stat entries."
      });
    }
  }).optional(),
  rotation: boundedStringArray.optional(),
  talents: boundedStringArray.optional(),
  perks: boundedStringArray.optional(),
  traits: boundedStringArray.optional(),
  consumables: boundedStringArray.optional(),
  companions: boundedStringArray.optional(),
  utility: boundedStringArray.optional(),
  strengths: boundedStringArray.optional(),
  weaknesses: boundedStringArray.optional(),
  constraints: boundedStringArray.optional(),
  notes: boundedStringArray.optional(),
  source: z.object({
    url: z.string().url().max(GAMING_BUILD_RESOURCE_HARD_LIMITS.maxUrlChars),
    resourceType: GamingResourceTypeSchema,
    extractor: z.string().min(1).max(128),
    confidence: z.number().finite().min(0).max(1)
  }).strict()
}).strict();
