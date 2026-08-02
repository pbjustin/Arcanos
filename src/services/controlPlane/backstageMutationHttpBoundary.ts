import type {
  NextFunction,
  Request,
  RequestHandler,
  Response,
} from 'express';

import { getGptModuleMap } from '@platform/runtime/gptRouterConfig.js';
import { legacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';
import {
  createRateLimitMiddleware,
  securityHeaders,
} from '@platform/runtime/security.js';
import {
  BACKSTAGE_MODULE_NAME,
  BACKSTAGE_MODULE_ROUTE,
  BACKSTAGE_MUTATION_SCOPE,
  isBackstagePublicAction,
  type BackstageMutationAction,
} from '@shared/backstage/backstageActionPolicy.js';
import { resolveDispatchLaneForRequest } from './dispatchDagCompatibilityBoundary.js';
import { validateGptIdentifier } from '@shared/gpt/gptIdentifier.js';
import {
  resolveGptModuleMapEntry,
  type GptModuleMapEntry,
} from '@shared/gpt/gptModuleMapResolution.js';
import { resolveRequestedGptActionFromRequest } from '@shared/gpt/gptRequestAction.js';
import { isProtectedModuleIdentifier } from '@services/moduleCatalog.js';
import {
  getModuleMetadata,
  initializeModuleRegistry,
  resolveLegacyModule,
} from '@services/moduleRegistry.js';
import {
  pickGptModuleAction,
  resolveGptModuleRequestedActionAlias,
} from '@shared/gpt/gptModuleAction.js';

import {
  authenticateControlPlaneHttpRequest,
  authorizeControlPlaneHttpScopes,
  controlPlaneHttpAuthenticationMiddleware,
  requireControlPlaneOperator,
} from './httpAuth.js';

export { BACKSTAGE_MUTATION_SCOPE };

const BACKSTAGE_MUTATION_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BACKSTAGE_MUTATION_CLIENT_RATE_LIMIT = 120;
const DEFAULT_BACKSTAGE_MUTATION_PRINCIPAL_RATE_LIMIT = 10;
const backstageMutationBoundaryApplied = Symbol('backstageMutationBoundaryApplied');
const backstageMutationResolution = Symbol('backstageMutationResolution');

const DIRECT_BACKSTAGE_MUTATIONS: Readonly<Record<string, BackstageMutationAction>> =
  Object.freeze({
    '/backstage/book-event': 'bookEvent',
    '/backstage/book-gpt': 'saveStoryline',
    '/backstage/track-storyline': 'trackStoryline',
    '/backstage/update-roster': 'updateRoster',
  });

export type BackstageMutationIngress =
  | 'canonical-gpt'
  | 'direct'
  | 'dispatch'
  | 'legacy-module'
  | 'legacy-queryroute';

export interface BackstageMutationHttpOperation {
  action: string;
  ingress: BackstageMutationIngress;
  scope: typeof BACKSTAGE_MUTATION_SCOPE;
}

type BackstageMutationBoundaryRequest = Request & {
  [backstageMutationBoundaryApplied]?: true;
  [backstageMutationResolution]?: Promise<BackstageMutationHttpOperation | null>;
};

export interface ResolveBackstageMutationHttpOperationOptions {
  gptModuleMap?: Readonly<Record<string, GptModuleMapEntry>>;
}

export interface BackstageMutationHttpBoundaryOptions {
  maxClientRequests?: number;
  maxPrincipalRequests?: number;
  windowMs?: number;
}

function normalizeRequestPath(req: Request): string {
  const baseUrl = typeof req.baseUrl === 'string' ? req.baseUrl : '';
  const requestPath = typeof req.path === 'string' ? req.path : '';
  const mountedPath = `${baseUrl}${requestPath === '/' && baseUrl ? '' : requestPath}`;
  if (mountedPath) {
    return mountedPath.replace(/\/+$/u, '') || '/';
  }

  const requestUrl = req.originalUrl || req.url || '';
  try {
    return new URL(requestUrl, 'http://arcanos.invalid').pathname.replace(/\/+$/u, '') || '/';
  } catch {
    return '/';
  }
}

function resolveIngressClientAddress(req: Request): string {
  const expressAddress = typeof req.ip === 'string' ? req.ip.trim() : '';
  if (expressAddress) {
    return expressAddress;
  }

  const socketAddress = typeof req.socket?.remoteAddress === 'string'
    ? req.socket.remoteAddress.trim()
    : '';
  return socketAddress || 'unknown';
}

function resolveCanonicalGptId(req: Request, path: string): string | null {
  const routeParameter = req.params?.gptId;
  if (typeof routeParameter === 'string' && routeParameter.trim()) {
    return routeParameter.trim();
  }

  const pathMatch = /^\/gpt\/([^/]+)$/iu.exec(path);
  if (!pathMatch) {
    return null;
  }

  try {
    return decodeURIComponent(pathMatch[1]);
  } catch {
    return null;
  }
}

async function resolveLegacyModuleMutation(
  req: Request,
  path: string
): Promise<BackstageMutationHttpOperation | null> {
  if (!legacyGptRoutesEnabled()) {
    return null;
  }

  const normalizedPath = path.toLowerCase();
  if (
    normalizedPath !== `/modules/${BACKSTAGE_MODULE_ROUTE}`
    && normalizedPath !== '/queryroute'
  ) {
    return null;
  }

  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : null;
  if (!body) {
    return null;
  }

  await initializeModuleRegistry();
  const registeredModule = resolveLegacyModule(
    typeof body.module === 'string' ? body.module : undefined
  );
  if (registeredModule?.definition.name !== BACKSTAGE_MODULE_NAME) {
    return null;
  }

  const action = typeof body.action === 'string'
    && Object.prototype.hasOwnProperty.call(registeredModule.definition.actions, body.action)
    ? body.action
    : null;
  if (!action || isBackstagePublicAction(action)) {
    return null;
  }

  if (normalizedPath === `/modules/${BACKSTAGE_MODULE_ROUTE}`) {
    return body.module === BACKSTAGE_MODULE_NAME
      ? {
          action,
          ingress: 'legacy-module',
          scope: BACKSTAGE_MUTATION_SCOPE,
        }
      : null;
  }

  if (
    normalizedPath === '/queryroute'
    && (body.module === BACKSTAGE_MODULE_NAME || body.module === BACKSTAGE_MODULE_ROUTE)
  ) {
    return {
      action,
      ingress: 'legacy-queryroute',
      scope: BACKSTAGE_MUTATION_SCOPE,
    };
  }

  return null;
}

async function resolveBackstageModuleActions(
  gptId: string,
  options: ResolveBackstageMutationHttpOperationOptions
): Promise<{
  actions: string[];
  defaultAction: string | null;
} | null> {
  const gptIdValidation = validateGptIdentifier(gptId);
  if (!gptIdValidation.ok || isProtectedModuleIdentifier(gptIdValidation.value)) {
    return null;
  }

  const gptModuleMap = options.gptModuleMap ?? await getGptModuleMap();
  if (
    resolveGptModuleMapEntry(gptIdValidation.value, gptModuleMap)?.entry.module
    !== BACKSTAGE_MODULE_NAME
  ) {
    return null;
  }

  await initializeModuleRegistry();
  const metadata = getModuleMetadata(BACKSTAGE_MODULE_NAME);
  return metadata
    ? {
        actions: metadata.actions,
        defaultAction: metadata.defaultAction ?? null,
      }
    : null;
}

function resolveValidBackstageGptAction(
  value: unknown,
  moduleActions: {
    actions: string[];
    defaultAction: string | null;
  }
): string | null {
  const rawAction = typeof value === 'string' ? value : undefined;
  const requestedAction = resolveGptModuleRequestedActionAlias(
    rawAction,
    moduleActions.actions
  );
  return pickGptModuleAction(
    moduleActions.actions,
    requestedAction,
    moduleActions.defaultAction
  );
}

/** Resolve only requests that can execute a valid state-changing Backstage action. */
async function resolveBackstageMutationHttpOperationUncached(
  req: Request,
  options: ResolveBackstageMutationHttpOperationOptions = {}
): Promise<BackstageMutationHttpOperation | null> {
  if (req.method.toUpperCase() !== 'POST') {
    return null;
  }

  const path = normalizeRequestPath(req);
  const directAction = DIRECT_BACKSTAGE_MUTATIONS[path.toLowerCase()];
  if (directAction) {
    return {
      action: directAction,
      ingress: 'direct',
      scope: BACKSTAGE_MUTATION_SCOPE,
    };
  }

  const legacyOperation = await resolveLegacyModuleMutation(req, path);
  if (legacyOperation) {
    return legacyOperation;
  }

  if (path.toLowerCase() === '/dispatch') {
    const resolution = resolveDispatchLaneForRequest(req);
    if (
      resolution.lane !== 'gpt'
      || !resolution.input.gptId
    ) {
      return null;
    }

    const moduleActions = await resolveBackstageModuleActions(
      resolution.input.gptId,
      options
    );
    const dispatchAction = moduleActions
      ? resolveValidBackstageGptAction(resolution.input.action, moduleActions)
      : null;
    if (!dispatchAction || isBackstagePublicAction(dispatchAction)) {
      return null;
    }

    return {
      action: dispatchAction,
      ingress: 'dispatch',
      scope: BACKSTAGE_MUTATION_SCOPE,
    };
  }

  const canonicalGptId = resolveCanonicalGptId(req, path);
  if (!canonicalGptId) {
    return null;
  }

  const moduleActions = await resolveBackstageModuleActions(canonicalGptId, options);
  const requestedAction = moduleActions
    ? resolveValidBackstageGptAction(
        resolveRequestedGptActionFromRequest(req),
        moduleActions
      )
    : null;
  if (!requestedAction || isBackstagePublicAction(requestedAction)) {
    return null;
  }

  return {
    action: requestedAction,
    ingress: 'canonical-gpt',
    scope: BACKSTAGE_MUTATION_SCOPE,
  };
}

/** Cache both public and protected classification for the lifetime of one request. */
export function resolveBackstageMutationHttpOperation(
  req: Request,
  options: ResolveBackstageMutationHttpOperationOptions = {}
): Promise<BackstageMutationHttpOperation | null> {
  const boundaryRequest = req as BackstageMutationBoundaryRequest;
  const cachedResolution = boundaryRequest[backstageMutationResolution];
  if (cachedResolution) {
    return cachedResolution;
  }

  const resolution = resolveBackstageMutationHttpOperationUncached(req, options)
    .catch((error: unknown) => {
      delete boundaryRequest[backstageMutationResolution];
      throw error;
    });
  boundaryRequest[backstageMutationResolution] = resolution;
  return resolution;
}

function setBackstageMutationNoStoreHeaders(
  _req: Request,
  res: Response,
  next: NextFunction
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

/** Apply one control-plane identity, scope, and rate boundary across Backstage aliases. */
export function createBackstageMutationHttpBoundary(
  options: BackstageMutationHttpBoundaryOptions = {}
): RequestHandler {
  const windowMs = options.windowMs ?? BACKSTAGE_MUTATION_RATE_LIMIT_WINDOW_MS;
  const clientRateLimit = createRateLimitMiddleware({
    bucketName: 'backstage-mutation-client',
    maxRequests: options.maxClientRequests ?? DEFAULT_BACKSTAGE_MUTATION_CLIENT_RATE_LIMIT,
    windowMs,
    skip: (req) => authenticateControlPlaneHttpRequest(req).ok,
    keyGenerator: (req) => (
      `ingress:${resolveIngressClientAddress(req)}:backstage-mutation`
    ),
  });
  const principalRateLimit = createRateLimitMiddleware({
    bucketName: 'backstage-mutation-principal',
    maxRequests: options.maxPrincipalRequests
      ?? DEFAULT_BACKSTAGE_MUTATION_PRINCIPAL_RATE_LIMIT,
    windowMs,
    keyGenerator: (req) => (
      `principal:${req.controlPlanePrincipal?.principalId ?? 'unknown'}:backstage-mutation`
    ),
  });
  const requireMutationScope: RequestHandler = (req, res, next): void => {
    authorizeControlPlaneHttpScopes(
      req,
      res,
      next,
      [BACKSTAGE_MUTATION_SCOPE],
      'backstage_mutation.http_authorization.denied'
    );
  };
  const middlewareChain: RequestHandler[] = [
    securityHeaders,
    setBackstageMutationNoStoreHeaders,
    clientRateLimit,
    controlPlaneHttpAuthenticationMiddleware,
    requireControlPlaneOperator,
    principalRateLimit,
    requireMutationScope,
  ];

  return (req: Request, res: Response, next: NextFunction): void => {
    const boundaryRequest = req as BackstageMutationBoundaryRequest;
    if (boundaryRequest[backstageMutationBoundaryApplied]) {
      next();
      return;
    }

    void resolveBackstageMutationHttpOperation(req)
      .then((operation) => {
        if (!operation) {
          next();
          return;
        }

        boundaryRequest[backstageMutationBoundaryApplied] = true;
        let middlewareIndex = 0;
        const advance = ((error?: unknown): void => {
          if (error !== undefined) {
            next(error);
            return;
          }

          const middleware = middlewareChain[middlewareIndex];
          middlewareIndex += 1;
          if (middleware) {
            middleware(req, res, advance);
            return;
          }

          req.logger?.info?.('backstage_mutation.http_admitted', {
            action: operation.action,
            ingress: operation.ingress,
            method: req.method,
          });
          next();
        }) as NextFunction;

        advance();
      })
      .catch(next);
  };
}

export const backstageMutationHttpBoundary =
  createBackstageMutationHttpBoundary();
