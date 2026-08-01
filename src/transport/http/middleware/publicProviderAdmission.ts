import type { Request, RequestHandler } from 'express';

import { config } from '@platform/runtime/config.js';
import { legacyGptRoutesEnabled as readLegacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';
import {
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
  normalizePublicProviderRateLimitMax,
  normalizePublicProviderRateLimitWindowMs,
} from '@platform/runtime/publicProviderRateLimitPolicy.js';
import { createRateLimitMiddleware, sanitizeInput } from '@platform/runtime/security.js';
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
export {
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_MAX,
  DEFAULT_PUBLIC_PROVIDER_RATE_LIMIT_WINDOW_MS,
};

const PUBLIC_PROVIDER_RATE_LIMIT_KEY = 'instance';
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

export interface PublicProviderRateLimitOptions {
  maxRequests?: number;
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

/**
 * Build one constant-key in-process ceiling.
 * Reusing the returned middleware is idempotent for a request, so compatibility
 * reroutes cannot double charge the same public admission.
 */
export function createPublicProviderRateLimitMiddleware(
  options: PublicProviderRateLimitOptions = {}
): RequestHandler {
  const maxRequests = normalizePublicProviderRateLimitMax(options.maxRequests);
  const windowMs = normalizePublicProviderRateLimitWindowMs(options.windowMs);
  const chargedRequestKey = Symbol('publicProviderRateLimitCharged');
  const rateLimit = createRateLimitMiddleware({
    bucketName: PUBLIC_PROVIDER_RATE_LIMIT_BUCKET,
    maxRequests,
    windowMs,
    keyGenerator: () => PUBLIC_PROVIDER_RATE_LIMIT_KEY,
  });

  return (req, res, next): void => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');

    const requestState = req as Request & { [key: symbol]: boolean | undefined };
    if (requestState[chargedRequestKey] === true) {
      next();
      return;
    }

    requestState[chargedRequestKey] = true;
    rateLimit(req, res, next);
  };
}

/** The only production counter instance; every public-provider seam reuses it. */
export const publicProviderRateLimit = createPublicProviderRateLimitMiddleware({
  maxRequests: config.limits.publicProviderRateLimitMax,
  windowMs: config.limits.publicProviderRateLimitWindowMs,
});

/** Apply the singleton only to the original public provider ingress catalog. */
export const publicProviderAdmission: RequestHandler = (req, res, next): void => {
  if (!isPublicProviderAdmissionRequest({
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
