import express, { NextFunction, Request, Response } from 'express';
import type { ModuleDef } from '@services/moduleLoader.js';
import {
  dispatchModuleAction,
  getModuleMetadata,
  getModulesForRegistry,
  getPublicModulesForRegistry,
  initializeModuleRegistry,
  listRegisteredModules,
  ModuleAccessDeniedError,
  ModuleActionNotFoundError,
  ModuleNotFoundError,
  resolveLegacyModule,
  resolveRegisteredModule
} from '@services/moduleRegistry.js';
import { isLegacyModuleExposed } from '@services/moduleCatalog.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { sendBadRequest, sendNotFound, sendInternalErrorPayload } from '@shared/http/index.js';
import { dispatchLegacyRouteToGpt } from './_core/legacyGptCompat.js';
import { applyLegacyRouteDeprecationHeaders, buildCanonicalGptRoute } from '@shared/http/gptRouteHeaders.js';
import { legacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';
import {
  buildLegacyModuleDispatchBody,
  unwrapLegacyModuleRouteResult
} from './_core/legacyRouteAdapters.js';

const router = express.Router();
await initializeModuleRegistry();

type ModuleDispatchRequestBody = {
  module?: string;
  action?: string;
  payload?: unknown;
};

export {
  dispatchModuleAction,
  getModuleMetadata,
  getModulesForRegistry,
  ModuleAccessDeniedError,
  ModuleActionNotFoundError,
  ModuleNotFoundError
};

function createHandler(mod: ModuleDef, route: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const canonicalGptId = mod.gptIds?.[0] ?? null;
    applyLegacyRouteDeprecationHeaders(
      res,
      canonicalGptId ? buildCanonicalGptRoute(canonicalGptId) : buildCanonicalGptRoute()
    );

    //audit Assumption: rerouted requests should not execute module actions; risk: conflicting side effects; invariant: module execution skipped; handling: log warning + return safe error.
    if (req.dispatchRerouted && req.dispatchDecision === 'reroute') {
      logger.warn('Rerouted request reached module handler unexpectedly', {
        module: 'modules',
        url: req.url,
        originalRoute: (req.body as Record<string, unknown>)?.dispatchReroute
      });
      return res.status(409).json({
        error: 'Dispatch rerouted to safe default dispatcher',
        code: 'DISPATCH_REROUTED',
        target: '/gpt/arcanos-daemon'
      });
    }

    const { module, action, payload } = req.body as ModuleDispatchRequestBody;
    if (module !== mod.name) {
      return sendNotFound(res, 'Module not found');
    }
    if (!action) {
      return sendBadRequest(res, 'Action is required');
    }
    const handler = mod.actions[action];
    if (!handler) {
      return sendNotFound(res, 'Action not found');
    }
    if (canonicalGptId) {
      return dispatchLegacyRouteToGpt(req, res, next, {
        legacyRoute: `/modules/${route}`,
        gptId: canonicalGptId,
        applyDeprecationHeaders: false,
        bodyTransform: () => buildLegacyModuleDispatchBody(action, payload),
        successBodyTransform: (result) => unwrapLegacyModuleRouteResult(result)
      });
    }
    try {
      const result = await handler(payload);
      res.json(result);
    } catch (err: unknown) {
      //audit Assumption: module failures should return 500
      sendInternalErrorPayload(res, { error: resolveErrorMessage(err) });
    }
  };
}

/**
 * Purpose: Mount a supplied legacy module handler for compatibility tests and
 * embedding callers. Runtime registry ownership remains in moduleRegistry.
 */
export function registerModule(route: string, mod: ModuleDef) {
  if (legacyGptRoutesEnabled() && isLegacyModuleExposed(mod)) {
    router.post(`/modules/${route}`, createHandler(mod, route));
  }
}

for (const { route, definition } of listRegisteredModules()) {
  registerModule(route, definition);
}

router.get('/registry', (_req: Request, res: Response) => {
  const modules = getPublicModulesForRegistry();

  res.json({
    count: modules.length,
    modules
  });
});

router.get('/registry/:moduleName', (req: Request, res: Response) => {
  const identifier = req.params.moduleName;
  const registered = resolveRegisteredModule(identifier);
  const mod = registered?.definition;

  if (!mod || !isLegacyModuleExposed(mod)) {
    return res.json({ exists: false, module: null });
  }

  return res.json({
    exists: true,
    module: {
      name: mod.name,
      description: mod.description ?? null,
      route: registered.route,
      actions: Object.keys(mod.actions),
      gptIds: mod.gptIds ?? [],
      defaultAction: mod.defaultAction
    }
  });
});

if (legacyGptRoutesEnabled()) {
  router.post('/queryroute', async (req: Request, res: Response, next: NextFunction) => {
    const { module: moduleName, action, payload } = req.body as ModuleDispatchRequestBody;
    const mod = resolveLegacyModule(moduleName)?.definition;
    const canonicalGptId = mod?.gptIds?.[0] ?? null;
    applyLegacyRouteDeprecationHeaders(
      res,
      canonicalGptId ? buildCanonicalGptRoute(canonicalGptId) : buildCanonicalGptRoute()
    );

    //audit Assumption: rerouted requests should not execute module query routes; risk: conflicting side effects; invariant: queryroute skipped; handling: log warning + return safe error.
    if (req.dispatchRerouted && req.dispatchDecision === 'reroute') {
      logger.warn('Rerouted request reached queryroute handler unexpectedly', {
        module: 'modules',
        url: req.url,
        originalRoute: (req.body as Record<string, unknown>)?.dispatchReroute
      });
      return res.status(409).json({
        error: 'Dispatch rerouted to safe default dispatcher',
        code: 'DISPATCH_REROUTED',
        target: '/gpt/arcanos-daemon'
      });
    }

    if (!moduleName) {
      return sendBadRequest(res, 'Module name is required');
    }
    if (!mod) {
      return sendNotFound(res, 'Module not found');
    }
    if (!action) {
      return sendBadRequest(res, 'Action is required');
    }
    const handler = mod.actions[action];
    if (!handler) {
      return sendNotFound(res, 'Action not found');
    }
    if (canonicalGptId) {
      return dispatchLegacyRouteToGpt(req, res, next, {
        legacyRoute: '/queryroute',
        gptId: canonicalGptId,
        applyDeprecationHeaders: false,
        bodyTransform: () => buildLegacyModuleDispatchBody(action, payload),
        successBodyTransform: (result) => unwrapLegacyModuleRouteResult(result)
      });
    }
    try {
      const result = await handler(payload);
      res.json(result);
    } catch (err: unknown) {
      //audit Assumption: module failures should return 500
      sendInternalErrorPayload(res, { error: resolveErrorMessage(err) });
    }
  });
}

export default router;
