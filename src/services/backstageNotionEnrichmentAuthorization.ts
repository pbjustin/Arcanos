import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { BackstageProtectedGenerationProvenance } from '@arcanos/protocol';

import { BACKSTAGE_MODULE_ROUTE } from '@shared/backstage/backstageActionPolicy.js';
import {
  backstageBookerAccessAuthMiddleware,
  hasPresentedAuthorizationHeader,
  isBackstageBookerAccessAuthenticated,
} from './backstageBookerAccessAuth.js';

interface BackstageNotionEnrichmentAuthorizationContext {
  authorized: boolean;
  enrichmentUsed: boolean;
  protectedGenerationExecution: boolean;
  protectedQueuedExecution: boolean;
  legacyQueuedExecution: boolean;
  protectedGenerationAuthority: BackstageProtectedGenerationAuthority | null;
}

export type BackstageProtectedGenerationAuthority =
  | 'notion'
  | 'legacy_postgresql';

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

/** Identify any managed-bearer generation, whether request-local or queued. */
export function isBackstageProtectedGenerationExecution(): boolean {
  return backstageNotionEnrichmentAuthorizationStorage.getStore()
    ?.protectedGenerationExecution === true;
}

/** Record retrieval provenance only after a server-owned context read succeeds. */
export function recordBackstageProtectedGenerationAuthority(
  authority: BackstageProtectedGenerationAuthority
): void {
  const context = backstageNotionEnrichmentAuthorizationStorage.getStore();
  if (context?.protectedGenerationExecution) {
    context.protectedGenerationAuthority = authority;
  }
}

/** Return closed protected provenance; it cannot be selected by request input. */
export function getBackstageProtectedGenerationProvenance():
  | BackstageProtectedGenerationProvenance
  | null {
  const context = backstageNotionEnrichmentAuthorizationStorage.getStore();
  if (!context?.protectedGenerationExecution || !context.protectedGenerationAuthority) {
    return null;
  }
  if (context.protectedGenerationAuthority === 'notion') {
    return {
      version: 1, protected: true, protectedGenerationCompleted: true,
      official: true, continuityVerified: true, authority: 'notion',
      snapshotStatus: 'current_complete', fallbackUsed: false, fallbackPermitted: false,
    };
  }
  if (context.protectedGenerationAuthority === 'legacy_postgresql') {
    return {
      version: 1, protected: true, protectedGenerationCompleted: true,
      official: true, continuityVerified: true, authority: 'legacy_postgresql',
      snapshotStatus: 'not_applicable', fallbackUsed: false, fallbackPermitted: false,
    };
  }
  return null;
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
      protectedGenerationExecution: false,
      protectedQueuedExecution: false,
      legacyQueuedExecution: false,
      protectedGenerationAuthority: null,
    },
    operation
  );
}

/** Run a managed-bearer request inside server-owned generation provenance. */
export function runWithBackstageProtectedGenerationRequest<T>(
  operation: () => T
): T {
  return backstageNotionEnrichmentAuthorizationStorage.run(
    {
      authorized: true,
      enrichmentUsed: false,
      protectedGenerationExecution: true,
      protectedQueuedExecution: false,
      legacyQueuedExecution: false,
      protectedGenerationAuthority: null,
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
      protectedGenerationExecution: true,
      protectedQueuedExecution: true,
      legacyQueuedExecution: false,
      protectedGenerationAuthority: null,
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
      protectedGenerationExecution: false,
      protectedQueuedExecution: false,
      legacyQueuedExecution: true,
      protectedGenerationAuthority: null,
    },
    operation
  );
}

/**
 * Establish Notion request provenance for the exact public Booker route.
 * A truly absent credential retains public non-Notion compatibility. Once an
 * Authorization header is presented, malformed, invalid, and unavailable
 * dedicated authentication fail closed before provider admission.
 */
export const optionalBackstageNotionEnrichmentAuth: RequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const gptId = typeof req.params.gptId === 'string' ? req.params.gptId : '';
  const originalPath = typeof req.originalUrl === 'string'
    ? req.originalUrl.split('?', 1)[0]
    : null;
  const isExactPublicRoute = originalPath
    ? originalPath === `/gpt/${BACKSTAGE_MODULE_ROUTE}`
    : gptId === BACKSTAGE_MODULE_ROUTE;
  if (gptId !== BACKSTAGE_MODULE_ROUTE || !isExactPublicRoute) {
    next();
    return;
  }

  // Canon mutations use the established control-plane identity on this same
  // route and must not be reinterpreted as dedicated Builder credentials.
  if (req.controlPlanePrincipal) {
    runWithBackstageNotionEnrichmentAuthorization(false, next);
    return;
  }

  if (isBackstageBookerAccessAuthenticated(req)) {
    runWithBackstageProtectedGenerationRequest(next);
    return;
  }

  if (!hasPresentedAuthorizationHeader(req)) {
    runWithBackstageNotionEnrichmentAuthorization(false, next);
    return;
  }

  backstageBookerAccessAuthMiddleware(req, res, () => {
    runWithBackstageProtectedGenerationRequest(next);
  });
};
