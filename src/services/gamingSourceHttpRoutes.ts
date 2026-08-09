import type { Request } from 'express';

export const GAMING_SOURCE_INGESTIONS_PATH =
  '/gpt-access/gaming/sources/ingestions';
export const GAMING_SOURCE_REFRESHES_PATH =
  '/gpt-access/gaming/sources/refreshes';

const GAMING_SOURCE_STATUS_ID_MAX_LENGTH = 128;
const MUTATION_METHODS = new Set(['DELETE', 'PATCH', 'POST', 'PUT']);

export type GamingSourceHttpTargetKind =
  | 'ingestion'
  | 'refresh'
  | 'status';
export type GamingSourceHttpOperationKind = 'read' | 'write';

export interface GamingSourceHttpTarget {
  kind: GamingSourceHttpTargetKind;
  scope: 'gaming.sources.read' | 'gaming.sources.write';
}

export interface GamingSourceHttpOperation extends GamingSourceHttpTarget {
  operationKind: GamingSourceHttpOperationKind;
}

export interface GamingSourceHttpResolution {
  target: GamingSourceHttpTarget;
  canonical: boolean;
}

function readRequestPath(req: Request): string {
  // Express derives `path` from both origin-form and absolute-form request
  // targets while preserving percent-encoded octets. Reattach the active
  // mount so this classifier sees the same full pathname that routing sees.
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const expressPath = typeof req.path === 'string' ? req.path : '';
  if (expressPath.startsWith('/')) {
    return `${baseUrl}${expressPath}`;
  }

  const requestUrl = req.originalUrl || req.url || req.path || '';
  const queryIndex = requestUrl.indexOf('?');
  return queryIndex >= 0 ? requestUrl.slice(0, queryIndex) : requestUrl;
}

function stripSingleTrailingSlash(rawPath: string): string | null {
  if (rawPath.length <= 1 || !rawPath.endsWith('/')) {
    return rawPath;
  }
  return rawPath.endsWith('//') ? null : rawPath.slice(0, -1);
}

function decodeCanonicalStatusId(rawId: string): string | null {
  if (/%2f/iu.test(rawId)) {
    return null;
  }
  let decodedId: string;
  try {
    decodedId = decodeURIComponent(rawId);
  } catch {
    return null;
  }
  if (
    decodedId.length === 0
    || decodedId.length > GAMING_SOURCE_STATUS_ID_MAX_LENGTH
    || decodedId.includes('%')
    || decodedId.includes('/')
    || decodedId.includes('\\')
    || /[\u0000-\u001F\u007F]/u.test(decodedId)
  ) {
    return null;
  }
  return decodedId;
}

function resolveGamingSourceHttpResolutionUncached(
  req: Request
): GamingSourceHttpResolution | null {
  const rawPath = readRequestPath(req);
  const normalizedRawPath = stripSingleTrailingSlash(rawPath);
  if (!normalizedRawPath) {
    return null;
  }
  const normalizedLowerPath = normalizedRawPath.toLowerCase();
  if (normalizedLowerPath === GAMING_SOURCE_INGESTIONS_PATH) {
    return {
      target: {
        kind: 'ingestion',
        scope: 'gaming.sources.write',
      },
      canonical: true,
    };
  }
  if (normalizedLowerPath === GAMING_SOURCE_REFRESHES_PATH) {
    return {
      target: {
        kind: 'refresh',
        scope: 'gaming.sources.write',
      },
      canonical: true,
    };
  }

  const statusPrefix = `${GAMING_SOURCE_INGESTIONS_PATH}/`;
  if (!normalizedLowerPath.startsWith(statusPrefix)) {
    return null;
  }
  const rawId = normalizedRawPath.slice(statusPrefix.length);
  if (rawId.length === 0 || rawId.includes('/')) {
    return null;
  }
  const method = normalizeRequestMethod(req.method);
  return {
    target: {
      kind: 'status',
      scope: method === 'GET'
        ? 'gaming.sources.read'
        : 'gaming.sources.write',
    },
    canonical: decodeCanonicalStatusId(rawId) !== null,
  };
}

function normalizeRequestMethod(method: string): string {
  const normalized = method.toUpperCase();
  return normalized === 'HEAD' ? 'GET' : normalized;
}

/**
 * Resolve the protected Gaming source namespace independently of HTTP method.
 * Unsupported methods remain inside the early auth/no-store boundary so they
 * cannot fall through to a generic execution-policy response.
 */
export function resolveGamingSourceHttpTarget(
  req: Request
): GamingSourceHttpTarget | null {
  return resolveGamingSourceHttpResolution(req)?.target ?? null;
}

/**
 * Classify the exact Gaming source HTTP surface while recording whether a
 * status identifier survives one canonical Express-compatible decode. Raw
 * one-segment status matches remain protected even when their identifier is
 * non-canonical, allowing the authenticated parser seam to reject them safely.
 */
export function resolveGamingSourceHttpResolution(
  req: Request
): GamingSourceHttpResolution | null {
  return resolveGamingSourceHttpResolutionUncached(req);
}

export function resolveGamingSourceHttpOperation(
  req: Request
): GamingSourceHttpOperation | null {
  const resolution = resolveGamingSourceHttpResolution(req);
  if (!resolution?.canonical) {
    return null;
  }
  const { target } = resolution;
  const method = normalizeRequestMethod(req.method);
  if (
    (target.kind === 'ingestion' || target.kind === 'refresh')
    && method === 'POST'
  ) {
    return {
      ...target,
      operationKind: 'write',
    };
  }
  if (target.kind === 'status' && method === 'GET') {
    return {
      ...target,
      operationKind: 'read',
    };
  }
  return null;
}

export function isGamingSourceMutationRequest(req: Request): boolean {
  return resolveGamingSourceHttpTarget(req) !== null
    && MUTATION_METHODS.has(req.method.toUpperCase());
}
