export const BACKSTAGE_SAVED_STORYLINE_TRANSFER_CODE_POINTS = 1_501;
export const BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS = 1_500;
export const BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS = 4_000;
export const BACKSTAGE_STORYLINE_SUMMARY_MAX_CODE_POINTS = 10_000;

// PostgreSQL's explicit LTRIM character set must stay aligned with
// ECMAScript trimStart() so the bounded transfer cannot hide valid content.
export const BACKSTAGE_SAVED_STORYLINE_TRIM_START_CHARACTERS =
  '\u0009\u000A\u000B\u000C\u000D\u0020\u00A0\u1680'
  + '\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A'
  + '\u2028\u2029\u202F\u205F\u3000\uFEFF';

export interface BackstageSavedStorylineExcerptProjection {
  storylineExcerpt: string;
  truncated: boolean;
}

export interface BackstageStorylineSummaryPageProjection {
  text: string | null;
  startCodePoint: number;
  endCodePointExclusive: number;
  totalCodePoints: number;
  hasMore: boolean;
  nextOffset: number | null;
}

interface BackstageStorylineSummaryProjectionRecord {
  universeId: string;
  storyKey: string;
  summary: string | null;
  version: number;
}

export type BackstageStorylineSummaryProjectionResult =
  | {
      ok: true;
      summaryPage: BackstageStorylineSummaryPageProjection;
    }
  | {
      ok: false;
      reason:
        | 'not-found'
        | 'offset-out-of-range'
        | 'scope-mismatch'
        | 'version-conflict';
    };

/**
 * Project one saved storyline after the repository's bounded transfer.
 * Leading whitespace is intentionally removed while trailing whitespace is
 * preserved to match the existing response contract.
 */
export function projectBackstageSavedStorylineExcerpt(
  value: unknown
): BackstageSavedStorylineExcerptProjection {
  if (typeof value !== 'string') {
    throw new TypeError(
      'Backstage saved storyline text must be a non-empty string.'
    );
  }
  const normalized = value.trimStart();
  if (normalized.trimEnd().length === 0) {
    throw new TypeError(
      'Backstage saved storyline text must be a non-empty string.'
    );
  }
  const codePoints = Array.from(normalized);
  const truncated =
    codePoints.length > BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS;
  return {
    storylineExcerpt: truncated
      ? codePoints
          .slice(0, BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS)
          .join('')
      : normalized,
    truncated,
  };
}

/**
 * Project one exact canon storyline summary page after the caller has resolved
 * the durable record. The scope and version checks stay coupled to Unicode
 * code-point paging so both the protected reader and the contained preview use
 * the same continuation behavior.
 */
export function projectBackstageStorylineSummaryPage(
  universeId: string,
  storyKey: string,
  storyline: BackstageStorylineSummaryProjectionRecord | null,
  options: {
    offset: number;
    expectedVersion?: number;
  }
): BackstageStorylineSummaryProjectionResult {
  if (!storyline) {
    return { ok: false, reason: 'not-found' };
  }
  if (
    storyline.universeId !== universeId
    || storyline.storyKey !== storyKey
  ) {
    return { ok: false, reason: 'scope-mismatch' };
  }
  if (
    options.expectedVersion !== undefined
    && storyline.version !== options.expectedVersion
  ) {
    return { ok: false, reason: 'version-conflict' };
  }

  const summaryCodePoints = storyline.summary === null
    ? []
    : Array.from(storyline.summary);
  if (
    !Number.isSafeInteger(options.offset)
    || options.offset < 0
    || options.offset > summaryCodePoints.length
  ) {
    return { ok: false, reason: 'offset-out-of-range' };
  }
  const endCodePointExclusive = Math.min(
    summaryCodePoints.length,
    options.offset + BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS
  );
  const hasMore = endCodePointExclusive < summaryCodePoints.length;

  return {
    ok: true,
    summaryPage: {
      text: storyline.summary === null
        ? null
        : summaryCodePoints
            .slice(options.offset, endCodePointExclusive)
            .join(''),
      startCodePoint: options.offset,
      endCodePointExclusive,
      totalCodePoints: summaryCodePoints.length,
      hasMore,
      nextOffset: hasMore ? endCodePointExclusive : null,
    },
  };
}
