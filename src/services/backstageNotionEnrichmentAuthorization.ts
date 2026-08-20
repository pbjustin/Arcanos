import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { BACKSTAGE_MODULE_ROUTE } from '@shared/backstage/backstageActionPolicy.js';
import { authenticateBackstageBookerAccessRequest } from './backstageBookerAccessAuth.js';

interface BackstageNotionEnrichmentAuthorizationContext {
  authorized: boolean;
  enrichmentUsed: boolean;
}

const backstageNotionEnrichmentAuthorizationStorage =
  new AsyncLocalStorage<BackstageNotionEnrichmentAuthorizationContext>();

/**
 * Return true only inside a canonical Backstage request whose dedicated bearer
 * was verified by the HTTP boundary. Caller-supplied payload fields cannot set
 * this request-local provenance.
 */
export function isBackstageNotionEnrichmentAuthorized(): boolean {
  return backstageNotionEnrichmentAuthorizationStorage.getStore()?.authorized === true;
}

/** Mark that private Notion material reached the model prompt for this request. */
export function markBackstageNotionEnrichmentUsed(): void {
  const context = backstageNotionEnrichmentAuthorizationStorage.getStore();
  if (context?.authorized) {
    context.enrichmentUsed = true;
  }
}

/**
 * Return true when the current request used private Notion material. Callers
 * use this provenance to suppress generic transcript/debug persistence.
 */
export function wasBackstageNotionEnrichmentUsed(): boolean {
  return backstageNotionEnrichmentAuthorizationStorage.getStore()?.enrichmentUsed === true;
}

/** Run trusted local work inside an explicit enrichment-authorization context. */
export function runWithBackstageNotionEnrichmentAuthorization<T>(
  authorized: boolean,
  operation: () => T
): T {
  return backstageNotionEnrichmentAuthorizationStorage.run(
    { authorized, enrichmentUsed: false },
    operation
  );
}

/**
 * Establish Notion request provenance without changing backend route admission.
 * Missing or invalid credentials retain non-Notion behavior only for a
 * non-authoritative universe; authority retrieval independently fails closed.
 */
export const optionalBackstageNotionEnrichmentAuth: RequestHandler = (
  req: Request,
  _res: Response,
  next: NextFunction
): void => {
  const gptId = typeof req.params.gptId === 'string' ? req.params.gptId : '';
  if (gptId !== BACKSTAGE_MODULE_ROUTE) {
    next();
    return;
  }

  const authentication = authenticateBackstageBookerAccessRequest(req);
  runWithBackstageNotionEnrichmentAuthorization(
    authentication.ok,
    next
  );
};
