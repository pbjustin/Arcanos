import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import { BACKSTAGE_MODULE_ROUTE } from '@shared/backstage/backstageActionPolicy.js';
import {
  authenticateBackstageBookerAccessRequest,
  establishBackstageBookerAccessAuthentication,
} from './backstageBookerAccessAuth.js';

interface BackstageNotionEnrichmentAuthorizationContext {
  authorized: boolean;
  enrichmentUsed: boolean;
  protectedQueuedExecution: boolean;
  legacyQueuedExecution: boolean;
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

/** Identify worker-only protected queue execution without trusting payload fields. */
export function isBackstageProtectedQueuedExecution(): boolean {
  return backstageNotionEnrichmentAuthorizationStorage.getStore()
    ?.protectedQueuedExecution === true;
}

/** Identify the temporary worker-only lane used to drain pre-contract rows. */
export function isBackstageLegacyQueuedExecution(): boolean {
  return backstageNotionEnrichmentAuthorizationStorage.getStore()
    ?.legacyQueuedExecution === true;
}

/** Run trusted local work inside an explicit enrichment-authorization context. */
export function runWithBackstageNotionEnrichmentAuthorization<T>(
  authorized: boolean,
  operation: () => T
): T {
  return backstageNotionEnrichmentAuthorizationStorage.run(
    {
      authorized,
      enrichmentUsed: false,
      protectedQueuedExecution: false,
      legacyQueuedExecution: false,
    },
    operation
  );
}

/** Run a protected Booker queue payload inside worker-only privacy fences. */
export function runWithBackstageProtectedQueuedExecution<T>(
  notionEnrichmentAuthorized: boolean,
  operation: () => T
): T {
  return backstageNotionEnrichmentAuthorizationStorage.run(
    {
      authorized: notionEnrichmentAuthorized,
      enrichmentUsed: false,
      protectedQueuedExecution: true,
      legacyQueuedExecution: false,
    },
    operation
  );
}

/**
 * Drain one marker-absent queue row created by the pre-contract web release.
 * The lane never grants private Notion access and remains distinct from the
 * authenticated protected-payload context.
 */
export function runWithBackstageLegacyQueuedExecution<T>(
  operation: () => T
): T {
  return backstageNotionEnrichmentAuthorizationStorage.run(
    {
      authorized: false,
      enrichmentUsed: false,
      protectedQueuedExecution: false,
      legacyQueuedExecution: true,
    },
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
  if (authentication.ok) {
    establishBackstageBookerAccessAuthentication(req, authentication.credential);
  }
  runWithBackstageNotionEnrichmentAuthorization(
    authentication.ok,
    next
  );
};
