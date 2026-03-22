import type { Response } from 'express';

export const CUSTOM_GPT_CONTRACT_PATH = '/contracts/custom_gpt_route.openapi.v1.json';
export const GPT_CANONICAL_ROUTE_TEMPLATE = '/gpt/{gptId}';
export const ASK_ROUTE_SUNSET_HEADER = 'Wed, 01 Jul 2026 00:00:00 GMT';

export function buildCanonicalGptRoute(gptId?: string | null): string {
  const trimmed = typeof gptId === 'string' ? gptId.trim() : '';
  if (!trimmed) {
    return GPT_CANONICAL_ROUTE_TEMPLATE;
  }

  return `/gpt/${encodeURIComponent(trimmed)}`;
}

export function applyCanonicalGptRouteHeaders(res: Response, gptId?: string | null): string {
  const canonicalRoute = buildCanonicalGptRoute(gptId);
  res.setHeader('x-canonical-route', canonicalRoute);
  res.append('Link', `<${CUSTOM_GPT_CONTRACT_PATH}>; rel="describedby"`);
  return canonicalRoute;
}

export function applyDeprecatedAskRouteHeaders(res: Response, gptId?: string | null): string {
  const canonicalRoute = applyCanonicalGptRouteHeaders(res, gptId);
  res.setHeader('Deprecation', 'true');
  res.setHeader('Sunset', ASK_ROUTE_SUNSET_HEADER);
  res.setHeader('x-route-deprecated', 'true');
  res.append('Link', `<${canonicalRoute}>; rel="successor-version"`);
  return canonicalRoute;
}
