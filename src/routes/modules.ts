import express, { NextFunction, Request, Response } from 'express';
import { loadModuleDefinitions, ModuleDef } from '@services/moduleLoader.js';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { sendBadRequest, sendNotFound, sendInternalErrorPayload } from '@shared/http/index.js';
import { dispatchLegacyRouteToGpt } from './_core/legacyGptCompat.js';
import { applyLegacyRouteDeprecationHeaders, buildCanonicalGptRoute } from '@shared/http/gptRouteHeaders.js';
import { legacyGptRoutesEnabled } from '@platform/runtime/legacyRouteMode.js';

const router = express.Router();

const registryByRoute = new Map<string, ModuleDef>();
const registryByName = new Map<string, ModuleDef>();
const moduleRoutes = new Map<string, string>();

type ModuleDispatchRequestBody = {
  module?: string;
  action?: string;
  payload?: unknown;
};

function resolveModuleDispatchTarget(moduleName: string | undefined): {
  mod: ModuleDef | undefined;
  canonicalGptId: string | null;
} {
  const mod = typeof moduleName === 'string'
    ? (registryByName.get(moduleName) ?? registryByRoute.get(moduleName))
    : undefined;
  const canonicalGptId = mod?.gptIds?.[0] ?? (typeof moduleName === 'string' ? moduleName : null);

  return {
    mod,
    canonicalGptId
  };
}

function createHandler(mod: ModuleDef, route: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const canonicalGptId = mod.gptIds?.[0] ?? mod.name;

    if (canonicalGptId) {
      return dispatchLegacyRouteToGpt(req, res, next, {
        legacyRoute: `/modules/${route}`,
        gptId: canonicalGptId
      });
    }

    applyLegacyRouteDeprecationHeaders(res, buildCanonicalGptRoute());

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
 * Purpose: Register a module definition and mount its handler route.
 * Inputs/Outputs: route string and ModuleDef; mounts handler and caches module metadata.
 * Edge cases: Overwrites existing module entries with the same route or name.
 */
export function registerModule(route: string, mod: ModuleDef) {
  registryByRoute.set(route, mod);
  registryByName.set(mod.name, mod);
  moduleRoutes.set(mod.name, route);
  if (legacyGptRoutesEnabled()) {
    router.post(`/modules/${route}`, createHandler(mod, route));
  }
}

/**
 * Purpose: Build a safe module registry snapshot for daemon prompts.
 * Inputs/Outputs: None; returns list of module metadata without gptIds.
 * Edge cases: Returns empty list when no modules are loaded.
 */
export function getModulesForRegistry(): Array<{
  id: string;
  description: string | null;
  route: string | null;
  actions: string[];
}> {
  //audit Assumption: registryByName holds current modules; risk: stale data; invariant: map values used; handling: map to safe shape.
  return Array.from(registryByName.values()).map(mod => ({
    id: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions)
  }));
}

/**
 * Purpose: Look up metadata for a single module by name.
 * Inputs/Outputs: Module name string; returns metadata or null.
 * Edge cases: Returns null when module name is not registered.
 */
export function getModuleMetadata(moduleName: string): {
  name: string;
  description: string | null;
  route: string | null;
  actions: string[];
  defaultAction?: string;
  defaultTimeoutMs?: number;
} | null {
  const mod = registryByName.get(moduleName);
  if (!mod) return null;
  return {
    name: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions),
    defaultAction: mod.defaultAction,
    defaultTimeoutMs: mod.defaultTimeoutMs,
  };
}

const loadedModules = await loadModuleDefinitions();
for (const { route, definition } of loadedModules) {
  registerModule(route, definition);
}

/**
 * Dispatch a module action directly by module name, action, and payload.
 * Used by the canonical /gpt/:gptId route to execute a resolved module action.
 */
export async function dispatchModuleAction(
  moduleName: string,
  action: string,
  payload: unknown
): Promise<unknown> {
  const mod = registryByName.get(moduleName);
  if (!mod) throw new Error(`Module not found: ${moduleName}`);
  const handler = mod.actions[action];
  if (!handler) throw new Error(`Action not found: ${action}`);
  return handler(payload);
}

router.get('/registry', (_req: Request, res: Response) => {
  const modules = Array.from(registryByName.values()).map((mod) => ({
    name: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions),
    gptIds: mod.gptIds ?? []
  }));

  res.json({
    count: modules.length,
    modules
  });
});

router.get('/registry/:moduleName', (req: Request, res: Response) => {
  const identifier = req.params.moduleName;
  let mod = registryByName.get(identifier);
  let route = moduleRoutes.get(identifier) ?? null;

  if (!mod) {
    mod = registryByRoute.get(identifier);
    if (mod) {
      route = moduleRoutes.get(mod.name) ?? identifier;
    }
  }

  if (!mod) {
    return res.json({ exists: false, module: null });
  }

  return res.json({
    exists: true,
    module: {
      name: mod.name,
      description: mod.description ?? null,
      route,
      actions: Object.keys(mod.actions),
      gptIds: mod.gptIds ?? [],
      defaultAction: mod.defaultAction
    }
  });
});

if (legacyGptRoutesEnabled()) {
  router.post('/queryroute', async (req: Request, res: Response, next: NextFunction) => {
    const { module: moduleName, action, payload } = req.body as ModuleDispatchRequestBody;
    const { mod, canonicalGptId } = resolveModuleDispatchTarget(moduleName);

    if (canonicalGptId) {
      return dispatchLegacyRouteToGpt(req, res, next, {
        legacyRoute: '/queryroute',
        gptId: canonicalGptId
      });
    }

    applyLegacyRouteDeprecationHeaders(res, buildCanonicalGptRoute());

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
