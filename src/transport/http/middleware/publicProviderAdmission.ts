import { isIP } from 'node:net';

import type { Request, RequestHandler } from 'express';

import { config } from '@platform/runtime/config.js';
import { legacyGptRoutesEnabled as readLegacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';
import {
  DEFAULT_PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
  normalizePublicProviderClientRateLimitMax,
  normalizePublicProviderRateLimitMax,
  normalizePublicProviderRateLimitWindowMs,
} from '@platform/runtime/publicProviderRateLimitPolicy.js';
import {
  createConfiguredPublicProviderRateLimitStore,
  createInMemoryPublicProviderRateLimitStore,
  PublicProviderRedisOperationStartRateError,
  type PublicProviderRateLimitDecision,
  type PublicProviderRateLimitStore,
} from '@platform/runtime/publicProviderRateLimitStore.js';
import {
  invalidatePublicProviderRateLimitReadiness,
} from '@platform/runtime/publicProviderRateLimitReadiness.js';
import { getRequestEstablishedActorKey, sanitizeInput } from '@platform/runtime/security.js';
import { classifyWritingPlaneInput } from '@platform/runtime/writingPlaneContract.js';
import {
  buildResolvedGptDispatchBody,
  resolveDispatchLane,
} from '@shared/dispatch/universalDispatch.js';
import {
  extractGptDispatchPromptText,
  extractGptPromptText,
  resolveRequestedGptAction,
} from '@shared/gpt/gptRequestAction.js';
import {
  GPT_QUERY_ACTION,
  GPT_QUERY_AND_WAIT_ACTION,
} from '@shared/gpt/gptJobResult.js';
import { isDiagnosticRequest } from '@shared/http/diagnosticRequest.js';
import {
  extractApiArcanosInput,
  extractBrainTextInput,
  resolveAskRequestSource,
} from '@shared/http/askRequestInput.js';
import {
  resolveAskRouteMode,
  type AskRouteMode,
} from '@shared/http/gptRouteHeaders.js';

export const PUBLIC_PROVIDER_RATE_LIMIT_BUCKET = 'public-provider-instance';
export const PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET = 'public-provider-client';
export const PUBLIC_PROVIDER_CONCURRENCY_RATE_LIMIT_BUCKET =
  'public-provider-admission-concurrency';
export const PUBLIC_PROVIDER_REDIS_START_RATE_LIMIT_BUCKET =
  'public-provider-admission-redis-start-rate';
export const DEFAULT_PUBLIC_PROVIDER_MAX_CONCURRENT_STORE_OPERATIONS = 16;
export {
  DEFAULT_PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
};

const publicProviderPostPaths = new Set([
  '/api/arcanos/ask',
  '/api/ask-hrc',
  '/api/openai/prompt',
  '/api/reusables',
  '/api/sim',
  '/api/transcribe',
  '/api/vision',
  '/api/web/search',
  '/arcanos-pipeline',
  '/backstage/book-gpt',
  '/commands/research',
  '/image',
  '/query-finetune',
  '/siri',
]);
const legacyProviderPostPaths = new Set([
  '/arcanos',
  '/guide',
  '/queryroute',
  '/sim',
  '/write',
]);
const canonicalGptPathPattern = /^\/gpt\/[^/]+$/;
const legacyModulePathPattern = /^\/modules\/[^/]+$/;
const ASK_LIKE_ROUTING_SIGNAL_FIELDS = [
  'mode',
  'action',
  'prompt',
  'message',
  'userInput',
  'content',
  'text',
  'query',
] as const;

export interface PublicProviderAdmissionCandidate {
  method: string;
  path: string;
  body?: unknown;
  query?: Record<string, unknown>;
  gptActionHeader?: unknown;
  arcanosActionHeader?: unknown;
}

export interface PublicProviderAdmissionMatcherOptions {
  legacyGptRoutesEnabled?: boolean;
  askRouteMode?: AskRouteMode;
}

export interface PublicProviderAdmissionMiddlewareOptions
  extends PublicProviderAdmissionMatcherOptions {
  rateLimitMiddleware?: RequestHandler;
}

export interface PublicProviderRateLimitOptions {
  clientIdentityResolver?: (req: Request) => string;
  clientMaxRequests?: number;
  maxRequests?: number;
  maxConcurrentStoreOperations?: number;
  railwayEdgePeerMatcher?: (address: string) => boolean;
  store?: PublicProviderRateLimitStore;
  trustRailwayRealIp?: boolean;
  windowMs?: number;
}

function normalizeRequestPath(path: string): string {
  const queryIndex = path.indexOf('?');
  const pathWithoutQuery = queryIndex >= 0 ? path.slice(0, queryIndex) : path;
  const normalized = pathWithoutQuery.trim().toLowerCase();
  if (normalized.length > 1 && normalized.endsWith('/')) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function sanitizeAskLikeRoutingPayload(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const sanitized = { ...record };
  for (const field of ASK_LIKE_ROUTING_SIGNAL_FIELDS) {
    const signal = sanitized[field];
    if (typeof signal === 'string') {
      sanitized[field] = sanitizeInput(signal);
    }
  }
  return sanitized;
}

function isProviderFreeBrainPayload(value: unknown): boolean {
  const payload = asRecord(value);
  const mode = payload?.mode;
  if (typeof mode === 'string' && mode.trim() === 'system_state') {
    return true;
  }

  if (typeof mode === 'string' && mode.trim() === 'system_review') {
    return false;
  }

  return isDiagnosticRequest(payload, extractBrainTextInput(payload));
}

function isProviderFreeApiArcanosPayload(value: unknown): boolean {
  const payload = asRecord(value);
  return isDiagnosticRequest(payload, extractApiArcanosInput(payload));
}

function isPublicProviderGptCandidate(candidate: PublicProviderAdmissionCandidate): boolean {
  const requestedAction = resolveRequestedGptAction({
    body: candidate.body,
    query: candidate.query,
    gptActionHeader: candidate.gptActionHeader,
    arcanosActionHeader: candidate.arcanosActionHeader,
  });
  const promptText =
    extractGptPromptText(candidate.body) ?? extractGptPromptText(candidate.query);
  const dispatchPromptText = extractGptDispatchPromptText(candidate.body);
  const explicitProviderQueryLane =
    Boolean(promptText)
    && (requestedAction === GPT_QUERY_ACTION || requestedAction === GPT_QUERY_AND_WAIT_ACTION);
  const explicitNonProviderAction =
    requestedAction !== null
    && requestedAction !== GPT_QUERY_ACTION
    && requestedAction !== GPT_QUERY_AND_WAIT_ACTION;
  const outerPromptAvoidsFastPath =
    !promptText || isDiagnosticRequest(undefined, promptText);
  const providerFreeDiagnostic =
    isDiagnosticRequest(asRecord(candidate.body), dispatchPromptText)
    && (explicitNonProviderAction || (!explicitProviderQueryLane && outerPromptAvoidsFastPath));
  if (!explicitProviderQueryLane && providerFreeDiagnostic) {
    return false;
  }

  return classifyWritingPlaneInput({
    body: candidate.body,
    promptText,
    requestedAction,
  }).plane === 'writing';
}

/** Identify only public HTTP requests that can admit external provider work. */
export function isPublicProviderAdmissionRequest(
  candidate: PublicProviderAdmissionCandidate,
  options: PublicProviderAdmissionMatcherOptions = {}
): boolean {
  const method = candidate.method.trim().toUpperCase();
  const path = normalizeRequestPath(candidate.path);
  if (path === '/brain') {
    const askRouteMode = options.askRouteMode ?? resolveAskRouteMode();
    const effectivePayload = sanitizeAskLikeRoutingPayload(
      resolveAskRequestSource(method, candidate.body, candidate.query)
    );
    return (method === 'GET' || method === 'HEAD' || method === 'POST')
      && askRouteMode === 'compat'
      && !isProviderFreeBrainPayload(effectivePayload);
  }

  if (method !== 'POST') {
    return false;
  }

  if (canonicalGptPathPattern.test(path)) {
    return isPublicProviderGptCandidate(candidate);
  }

  if (path === '/api/arcanos/ask') {
    return !isProviderFreeApiArcanosPayload(sanitizeAskLikeRoutingPayload(candidate.body));
  }

  if (publicProviderPostPaths.has(path)) {
    return true;
  }

  if (path === '/dispatch') {
    const resolution = resolveDispatchLane(candidate.body);
    if (resolution.lane !== 'gpt') {
      return false;
    }

    const preparedBody = buildResolvedGptDispatchBody(resolution.input);
    const effectivePromptText = extractGptDispatchPromptText(preparedBody);
    if (isDiagnosticRequest(asRecord(preparedBody), effectivePromptText)) {
      return false;
    }

    const requestedAction = typeof preparedBody.action === 'string'
      ? preparedBody.action.trim()
      : null;
    return classifyWritingPlaneInput({
      body: preparedBody,
      promptText: effectivePromptText,
      requestedAction,
    }).plane === 'writing';
  }

  const legacyRoutesEnabled = options.legacyGptRoutesEnabled
    ?? readLegacyGptRoutesEnabled();
  if (!legacyRoutesEnabled) {
    return false;
  }

  return legacyProviderPostPaths.has(path) || legacyModulePathPattern.test(path);
}

function parseIpv4Groups(address: string): number[] | null {
  if (isIP(address) !== 4) {
    return null;
  }
  const groups = address.split('.').map((value) => Number(value));
  return groups.length === 4 && groups.every((value) => Number.isInteger(value))
    ? groups
    : null;
}

function parseIpv6Groups(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }

  let normalized = address.toLowerCase();
  const embeddedIpv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (embeddedIpv4Match?.[1]) {
    const ipv4Groups = parseIpv4Groups(embeddedIpv4Match[1]);
    if (!ipv4Groups) {
      return null;
    }
    const first = ((ipv4Groups[0] ?? 0) << 8) | (ipv4Groups[1] ?? 0);
    const second = ((ipv4Groups[2] ?? 0) << 8) | (ipv4Groups[3] ?? 0);
    normalized = normalized.slice(0, -embeddedIpv4Match[1].length)
      + `${first.toString(16)}:${second.toString(16)}`;
  }

  const halves = normalized.split('::');
  if (halves.length > 2) {
    return null;
  }
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missingGroups = 8 - left.length - right.length;
  if ((halves.length === 1 && missingGroups !== 0) || missingGroups < 0) {
    return null;
  }
  const rawGroups = halves.length === 2
    ? [...left, ...Array.from({ length: missingGroups }, () => '0'), ...right]
    : left;
  if (rawGroups.length !== 8 || rawGroups.some((value) => !/^[0-9a-f]{1,4}$/u.test(value))) {
    return null;
  }
  return rawGroups.map((value) => Number.parseInt(value, 16));
}

/** Collapse IPv6 privacy addresses to a stable /64 caller cohort. */
export function normalizePublicProviderClientAddress(address: string): string | null {
  const trimmed = address.trim();
  const ipv4Groups = parseIpv4Groups(trimmed);
  if (ipv4Groups) {
    return `ipv4:${ipv4Groups.join('.')}/32`;
  }

  const ipv6Groups = parseIpv6Groups(trimmed);
  if (!ipv6Groups) {
    return null;
  }
  if (
    ipv6Groups.slice(0, 5).every((value) => value === 0)
    && ipv6Groups[5] === 0xffff
  ) {
    const firstIpv4Group = (ipv6Groups[6] ?? 0) >> 8;
    const secondIpv4Group = (ipv6Groups[6] ?? 0) & 0xff;
    const thirdIpv4Group = (ipv6Groups[7] ?? 0) >> 8;
    const fourthIpv4Group = (ipv6Groups[7] ?? 0) & 0xff;
    return `ipv4:${[
      firstIpv4Group,
      secondIpv4Group,
      thirdIpv4Group,
      fourthIpv4Group,
    ].join('.')}/32`;
  }

  const network = ipv6Groups
    .slice(0, 4)
    .map((value) => value.toString(16).padStart(4, '0'))
    .join(':');
  return `ipv6:${network}::/64`;
}

function readSingleRealIpHeader(req: Request): string | null {
  const header = req.headers['x-real-ip'];
  if (typeof header !== 'string' || header.includes(',')) {
    return null;
  }
  return normalizePublicProviderClientAddress(header);
}

function hasValidRailwayEdgeHeader(req: Request): boolean {
  const header = req.headers['x-railway-edge'];
  return typeof header === 'string' && /^[a-z]{3}\d{1,3}$/iu.test(header.trim());
}

/** Railway's documented proxy range for trusted forwarding headers. */
export function isTrustedRailwayEdgePeerAddress(address: string): boolean {
  const normalized = normalizePublicProviderClientAddress(address);
  return normalized?.startsWith('ipv4:100.') === true;
}

/** Resolve only server-established identity or verified ingress network identity. */
export function resolvePublicProviderClientIdentity(
  req: Request,
  options: {
    railwayEdgePeerMatcher?: (address: string) => boolean;
    trustRailwayRealIp?: boolean;
  } = {}
): string {
  const establishedActor = getRequestEstablishedActorKey(req);
  if (establishedActor) {
    return `actor:${establishedActor}`;
  }

  const socketAddress = typeof req.socket?.remoteAddress === 'string'
    ? req.socket.remoteAddress
    : '';
  const railwayEdgePeerMatcher = options.railwayEdgePeerMatcher
    ?? isTrustedRailwayEdgePeerAddress;
  if (
    options.trustRailwayRealIp
    && socketAddress
    && railwayEdgePeerMatcher(socketAddress)
    && hasValidRailwayEdgeHeader(req)
  ) {
    const realIpIdentity = readSingleRealIpHeader(req);
    if (realIpIdentity) {
      return realIpIdentity;
    }
  }

  const normalizedSocketAddress = normalizePublicProviderClientAddress(socketAddress);
  return `network:${normalizedSocketAddress ?? 'unknown'}`;
}

function applyPublicProviderRateLimitHeaders(
  res: Parameters<RequestHandler>[1],
  decision: PublicProviderRateLimitDecision
): void {
  const selectedTier = decision.limitedTier === 'client'
    ? decision.client
    : decision.global;
  const selectedBucket = decision.limitedTier === 'client'
    ? PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET
    : PUBLIC_PROVIDER_RATE_LIMIT_BUCKET;
  const preserveUpstreamRateLimitHeaders =
    decision.allowed && res.hasHeader('X-RateLimit-Bucket');
  const headers: Record<string, string> = {};
  if (!preserveUpstreamRateLimitHeaders) {
    headers['X-RateLimit-Limit'] = String(selectedTier.limit);
    headers['X-RateLimit-Remaining'] = String(selectedTier.remaining);
    headers['X-RateLimit-Reset'] = new Date(selectedTier.resetTimeMs).toISOString();
    headers['X-RateLimit-Bucket'] = selectedBucket;
  }
  if (decision.clientSnapshotFresh !== false) {
    headers['X-Public-Provider-Client-Remaining'] = String(decision.client.remaining);
  }
  if (decision.globalSnapshotFresh !== false) {
    headers['X-Public-Provider-Global-Remaining'] = String(decision.global.remaining);
  }
  res.set(headers);
}

/**
 * Build one atomic caller-plus-deployment ceiling. Reusing the returned
 * middleware is idempotent so compatibility reroutes charge exactly once.
 */
export function createPublicProviderRateLimitMiddleware(
  options: PublicProviderRateLimitOptions = {}
): RequestHandler {
  const maxRequests = normalizePublicProviderRateLimitMax(options.maxRequests);
  const clientMaxRequests = normalizePublicProviderClientRateLimitMax(
    options.clientMaxRequests,
    maxRequests
  );
  const windowMs = normalizePublicProviderRateLimitWindowMs(options.windowMs);
  const configuredConcurrency = options.maxConcurrentStoreOperations;
  const maxConcurrentStoreOperations = Number.isSafeInteger(configuredConcurrency)
    && Number(configuredConcurrency) >= 1
    ? Math.min(Number(configuredConcurrency), DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX)
    : Math.min(maxRequests, DEFAULT_PUBLIC_PROVIDER_MAX_CONCURRENT_STORE_OPERATIONS);
  const chargedRequestKey = Symbol('publicProviderRateLimitCharged');
  let activeStoreOperations = 0;
  const store = options.store ?? createInMemoryPublicProviderRateLimitStore();
  const clientIdentityResolver = options.clientIdentityResolver
    ?? ((req: Request) => resolvePublicProviderClientIdentity(req, {
      railwayEdgePeerMatcher: options.railwayEdgePeerMatcher,
      trustRailwayRealIp: options.trustRailwayRealIp,
    }));

  return (req, res, next): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const requestState = req as Request & { [key: symbol]: boolean | undefined };
    if (requestState[chargedRequestKey] === true) {
      next();
      return;
    }

    requestState[chargedRequestKey] = true;
    if (activeStoreOperations >= maxConcurrentStoreOperations) {
      res.set({
        'X-RateLimit-Limit': String(maxConcurrentStoreOperations),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Bucket': PUBLIC_PROVIDER_CONCURRENCY_RATE_LIMIT_BUCKET,
        'Retry-After': '2',
      });
      void res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests for ${
          PUBLIC_PROVIDER_CONCURRENCY_RATE_LIMIT_BUCKET
        }. Try again later.`,
        retryAfter: 2,
      });
      return;
    }

    activeStoreOperations += 1;
    let storeOperationReleased = false;
    const releaseStoreOperation = (): void => {
      if (storeOperationReleased) {
        return;
      }
      storeOperationReleased = true;
      activeStoreOperations = Math.max(0, activeStoreOperations - 1);
    };

    const handleStoreFailure = (error: unknown): void => {
      releaseStoreOperation();
      if (error instanceof PublicProviderRedisOperationStartRateError) {
        const retryAfterSeconds = Math.max(1, Math.ceil(error.retryAfterMs / 1000));
        res.set({
          'X-RateLimit-Limit': String(error.maximum),
          'X-RateLimit-Remaining': '0',
          'X-RateLimit-Bucket': PUBLIC_PROVIDER_REDIS_START_RATE_LIMIT_BUCKET,
          'Retry-After': String(retryAfterSeconds),
        });
        void res.status(429).json({
          error: 'Rate limit exceeded',
          message: `Too many requests for ${
            PUBLIC_PROVIDER_REDIS_START_RATE_LIMIT_BUCKET
          }. Try again later.`,
          retryAfter: retryAfterSeconds,
        });
        return;
      }
      next(error);
    };

    let consumePromise: Promise<PublicProviderRateLimitDecision>;
    try {
      consumePromise = store.consume({
        clientIdentity: clientIdentityResolver(req),
        clientMaximum: clientMaxRequests,
        globalMaximum: maxRequests,
        windowMs,
        requestId: req.requestId,
        traceId: req.traceId,
      });
    } catch (error) {
      handleStoreFailure(error);
      return;
    }

    void consumePromise.then((decision) => {
      releaseStoreOperation();
      applyPublicProviderRateLimitHeaders(res, decision);
      if (decision.allowed) {
        next();
        return;
      }

      const limitedTier = decision.limitedTier === 'client'
        ? decision.client
        : decision.global;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(limitedTier.retryAfterMs / 1000)
      );
      res.setHeader('Retry-After', String(retryAfterSeconds));
      void res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests for ${
          decision.limitedTier === 'client'
            ? PUBLIC_PROVIDER_CLIENT_RATE_LIMIT_BUCKET
            : PUBLIC_PROVIDER_RATE_LIMIT_BUCKET
        }. Try again later.`,
        retryAfter: retryAfterSeconds,
      });
    }).catch(handleStoreFailure);
  };
}

/** The only production counter instance; every public-provider seam reuses it. */
export const publicProviderRateLimit = createPublicProviderRateLimitMiddleware({
  clientMaxRequests: config.limits.publicProviderClientRateLimitMax,
  maxRequests: config.limits.publicProviderRateLimitMax,
  store: createConfiguredPublicProviderRateLimitStore({
    mode: config.limits.publicProviderRateLimitStore,
    namespace: config.limits.publicProviderRateLimitNamespace,
    onCapabilityFailure: invalidatePublicProviderRateLimitReadiness,
  }),
  trustRailwayRealIp: config.limits.publicProviderTrustRailwayRealIp,
  windowMs: config.limits.publicProviderRateLimitWindowMs,
});

/** Snapshot route-mode configuration with the routes mounted into one app. */
export function createPublicProviderAdmissionMiddleware(
  options: PublicProviderAdmissionMiddlewareOptions = {}
): RequestHandler {
  const { rateLimitMiddleware = publicProviderRateLimit, ...matcherInput } = options;
  const matcherOptions: PublicProviderAdmissionMatcherOptions = {
    ...matcherInput,
    legacyGptRoutesEnabled: matcherInput.legacyGptRoutesEnabled
      ?? readLegacyGptRoutesEnabled(),
  };

  return (req, res, next): void => {
    if (!isPublicProviderAdmissionRequest({
      method: req.method,
      path: req.path,
      body: req.body,
      query: req.query as Record<string, unknown>,
      gptActionHeader: req.header('x-gpt-action'),
      arcanosActionHeader: req.header('x-arcanos-action'),
    }, matcherOptions)) {
      next();
      return;
    }

    rateLimitMiddleware(req, res, next);
  };
}

/** Recheck the generic GPT leaf so internal compatibility reroutes cannot bypass admission. */
export const publicProviderGptAdmission: RequestHandler = (req, res, next): void => {
  if (!isPublicProviderGptCandidate({
    method: req.method,
    path: req.path,
    body: req.body,
    query: req.query as Record<string, unknown>,
    gptActionHeader: req.header('x-gpt-action'),
    arcanosActionHeader: req.header('x-arcanos-action'),
  })) {
    next();
    return;
  }

  publicProviderRateLimit(req, res, next);
};
