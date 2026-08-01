import {
  INVALID_GPT_IDENTIFIER_PLACEHOLDER,
  MAX_GPT_IDENTIFIER_LENGTH,
} from '@shared/gpt/gptIdentifier.js';

export interface RequestPathSource {
  path?: string;
  originalUrl?: string;
}

function sanitizeCanonicalGptIdentifier(path: string): string {
  const match = /^(\/gpt\/)([^/]+)(\/?)$/i.exec(path);
  if (!match) {
    return path;
  }

  const rawIdentifier = match[2] ?? '';
  let decodedIdentifier = rawIdentifier;
  try {
    decodedIdentifier = decodeURIComponent(rawIdentifier);
  } catch {
    // Preserve malformed short paths for the normal HTTP error boundary, while
    // still bounding malformed caller input that exceeds the GPT ID ceiling.
  }

  if (
    rawIdentifier.length <= MAX_GPT_IDENTIFIER_LENGTH
    && decodedIdentifier.length <= MAX_GPT_IDENTIFIER_LENGTH
  ) {
    return path;
  }

  return `${match[1]}${INVALID_GPT_IDENTIFIER_PLACEHOLDER}${match[3] ?? ''}`;
}

/**
 * Purpose: Strip query parameters from request paths before logging.
 * Inputs/Outputs: Accepts a raw path string and returns a sanitized path string.
 * Edge cases: Returns "/" when the input is empty or query-only.
 */
export function sanitizeRequestPath(rawPath: string): string {
  const trimmedPath = rawPath.trim();
  if (trimmedPath.length === 0) {
    return '/';
  }

  const queryStartIndex = trimmedPath.indexOf('?');
  //audit Assumption: query parameters may contain sensitive data and must never be logged in path fields; failure risk: token/PII disclosure in logs; expected invariant: returned path excludes query text; handling strategy: truncate at the first query delimiter.
  if (queryStartIndex >= 0) {
    const pathWithoutQuery = trimmedPath.slice(0, queryStartIndex);
    return pathWithoutQuery.length > 0 ? sanitizeCanonicalGptIdentifier(pathWithoutQuery) : '/';
  }

  return sanitizeCanonicalGptIdentifier(trimmedPath);
}

/**
 * Purpose: Resolve the safest request path for log output.
 * Inputs/Outputs: Uses Express-like request path fields and returns a sanitized path.
 * Edge cases: Prefers `path`, falls back to sanitized `originalUrl`, then defaults to "/".
 */
export function resolveSafeRequestPath(request: RequestPathSource): string {
  const requestPath = typeof request.path === 'string' ? request.path : '';
  if (requestPath.trim().length > 0) {
    return sanitizeRequestPath(requestPath);
  }

  const originalUrl = typeof request.originalUrl === 'string' ? request.originalUrl : '';
  if (originalUrl.trim().length > 0) {
    return sanitizeRequestPath(originalUrl);
  }

  return '/';
}
