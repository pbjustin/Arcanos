export const BACKSTAGE_SAVED_STORYLINE_TRANSFER_CODE_POINTS = 1_501;
export const BACKSTAGE_SAVED_STORYLINE_EXCERPT_CODE_POINTS = 1_500;

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
