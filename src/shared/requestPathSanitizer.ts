export interface RequestPathSource {
  path?: string;
  originalUrl?: string;
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
    return pathWithoutQuery.length > 0 ? pathWithoutQuery : '/';
  }

  return trimmedPath;
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
