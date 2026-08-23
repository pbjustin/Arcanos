export const BACKSTAGE_NOTION_BOOKING_SCOPE_SCORE_BOOST = 0.18;
export const BACKSTAGE_NOTION_BOOKING_NEUTRAL_CHUNK_RESERVE = 2;

export const BACKSTAGE_NOTION_BOOKING_BRANDS = Object.freeze([
  'raw',
  'smackdown',
  'nxt',
] as const);

export type BackstageNotionBookingBrand =
  (typeof BACKSTAGE_NOTION_BOOKING_BRANDS)[number];

export type BackstageNotionBookingScopeStrategy =
  | 'brand'
  | 'cross_brand'
  | 'fallback_all';

export interface BackstageNotionBookingScopePlan {
  strategy: BackstageNotionBookingScopeStrategy;
  detectedBrands: readonly BackstageNotionBookingBrand[];
  allowedBrands: readonly BackstageNotionBookingBrand[];
  explicitCrossBrand: boolean;
  fallbackReason: 'underspecified_query' | null;
}

export interface BackstageNotionBookingScopeCandidate {
  pageTitle: string;
  pagePath: readonly string[];
  headingPath: readonly string[];
  category?: string;
}

export interface BackstageNotionBookingCandidateScope {
  disposition: 'preferred' | 'neutral' | 'excluded';
  brands: readonly BackstageNotionBookingBrand[];
}

const BRAND_PATTERNS: Readonly<Record<
  BackstageNotionBookingBrand,
  RegExp
>> = Object.freeze({
  raw: /\braw\b/iu,
  smackdown: /\bsmack(?:[\s-]?down)\b/iu,
  nxt: /\bnxt\b/iu,
});

const EXPLICIT_CROSS_BRAND_PATTERN =
  /\b(?:cross[\s-]?brand|inter[\s-]?brand|forbidden[\s-]?door)\b/iu;

function normalizeScopeSignal(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F-\u009F]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function detectBrands(
  value: string,
  source: 'metadata' | 'query'
): BackstageNotionBookingBrand[] {
  const normalized = normalizeScopeSignal(value);
  return BACKSTAGE_NOTION_BOOKING_BRANDS.filter(brand => (
    brand === 'raw' && source === 'query'
      ? /\b(?:monday\s+night\s+raw|wwe\s+raw|raw\s+(?:show|brand|roster|card|episode|champion|championship|storyline|booking|main\s+event)|raw\s+(?:vs\.?|versus|and|&)\s+(?:smack(?:[\s-]?down)|nxt)|(?:show|brand|roster|card|episode|champion|championship|storyline|book|booking|match|event)\s+(?:for\s+)?raw)\b/iu
        .test(normalized)
      : BRAND_PATTERNS[brand].test(normalized)
  ));
}

/** Build a closed, prompt-content-free plan for booking-only retrieval. */
export function resolveBackstageNotionBookingScopePlan(
  query: string
): BackstageNotionBookingScopePlan {
  const normalizedQuery = normalizeScopeSignal(query);
  const detectedBrands = detectBrands(normalizedQuery, 'query');
  const explicitCrossBrand = EXPLICIT_CROSS_BRAND_PATTERN.test(normalizedQuery);
  if (detectedBrands.length === 0 && !explicitCrossBrand) {
    return Object.freeze({
      strategy: 'fallback_all',
      detectedBrands: Object.freeze([]),
      allowedBrands: Object.freeze([]),
      explicitCrossBrand: false,
      fallbackReason: 'underspecified_query',
    });
  }
  const strategy = explicitCrossBrand || detectedBrands.length > 1
    ? 'cross_brand'
    : 'brand';
  const allowedBrands = explicitCrossBrand && detectedBrands.length < 2
    ? [...BACKSTAGE_NOTION_BOOKING_BRANDS]
    : [...detectedBrands];
  return Object.freeze({
    strategy,
    detectedBrands: Object.freeze([...detectedBrands]),
    allowedBrands: Object.freeze(allowedBrands),
    explicitCrossBrand,
    fallbackReason: null,
  });
}

/**
 * Classify only indexed hierarchy metadata. Chunk prose is deliberately not a
 * scope authority because cross-brand facts may appear inside otherwise
 * brand-local pages.
 */
export function classifyBackstageNotionBookingCandidateScope(
  plan: BackstageNotionBookingScopePlan,
  candidate: BackstageNotionBookingScopeCandidate
): BackstageNotionBookingCandidateScope {
  const normalizedCategory = normalizeScopeSignal(candidate.category ?? '')
    .toLocaleLowerCase('en-US');
  const categoryBrand = BACKSTAGE_NOTION_BOOKING_BRANDS.find(
    brand => normalizedCategory === brand
  );
  const brands = detectBrands([
    candidate.pageTitle,
    ...candidate.pagePath,
    ...candidate.headingPath,
    ...(categoryBrand ? [categoryBrand] : []),
  ].join(' '), 'metadata');
  if (plan.strategy === 'fallback_all') {
    return Object.freeze({
      disposition: brands.length > 0 ? 'preferred' : 'neutral',
      brands: Object.freeze(brands),
    });
  }
  const allowed = new Set(plan.allowedBrands);
  if (brands.some(brand => !allowed.has(brand))) {
    return Object.freeze({
      disposition: 'excluded',
      brands: Object.freeze(brands),
    });
  }
  return Object.freeze({
    disposition: brands.some(brand => allowed.has(brand))
      ? 'preferred'
      : 'neutral',
    brands: Object.freeze(brands),
  });
}

/** Keep the highest-ranked deterministic representative of equal content. */
export function deduplicateBackstageNotionBookingCandidates<
  T extends { chunk: { contentHash: string } }
>(ranked: readonly T[]): {
  candidates: T[];
  duplicatesRemoved: number;
} {
  const seenContentHashes = new Set<string>();
  const candidates: T[] = [];
  for (const candidate of ranked) {
    if (seenContentHashes.has(candidate.chunk.contentHash)) {
      continue;
    }
    seenContentHashes.add(candidate.chunk.contentHash);
    candidates.push(candidate);
  }
  return {
    candidates,
    duplicatesRemoved: ranked.length - candidates.length,
  };
}
