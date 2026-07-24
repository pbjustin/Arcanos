import express, { NextFunction, Request, Response } from 'express';
import {
  loadModuleDefinitions,
  type ModuleActionMetadata,
  type ModuleActionExecutionTarget,
  type ModuleActionRisk,
  type ModuleDef,
  type ModuleHandlerContext
} from '@services/moduleLoader.js';
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

const registryByRoute = new Map<string, ModuleDef>();
const registryByName = new Map<string, ModuleDef>();
const moduleRoutes = new Map<string, string>();

type ResolvedModuleActionMetadata = ModuleActionMetadata & {
  requiresConfirmation: boolean;
};

type ModuleDispatchRequestBody = {
  module?: string;
  action?: string;
  payload?: unknown;
};

export class ModuleNotFoundError extends Error {
  constructor(moduleName: string) {
    super(`Module not found: ${moduleName}`);
    this.name = 'ModuleNotFoundError';
  }
}

export class ModuleActionNotFoundError extends Error {
  constructor(action: string) {
    super(`Action not found: ${action}`);
    this.name = 'ModuleActionNotFoundError';
  }
}

export class ModuleAccessDeniedError extends Error {
  constructor(moduleName: string) {
    super(`Module access denied: ${moduleName}`);
    this.name = 'ModuleAccessDeniedError';
  }
}

function isModuleActionRisk(value: unknown): value is ModuleActionRisk {
  return value === 'readonly' || value === 'privileged' || value === 'destructive';
}

function isModuleActionExecutionTarget(
  value: unknown
): value is ModuleActionExecutionTarget {
  return value === 'typescript' || value === 'python-daemon';
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isValidDeviceScope(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value);
}

function resolveModuleActionMetadata(
  mod: ModuleDef,
  action: string
): ResolvedModuleActionMetadata {
  const candidate = mod.actionMetadata?.[action] as ModuleActionMetadata | undefined;
  if (
    !candidate
    || !isModuleActionRisk(candidate.risk)
    || (
      candidate.requiresConfirmation !== undefined
      && typeof candidate.requiresConfirmation !== 'boolean'
    )
    || (
      candidate.readOnly !== undefined
      && (
        typeof candidate.readOnly !== 'boolean'
        || candidate.readOnly !== (candidate.risk === 'readonly')
      )
    )
    || (
      candidate.mayModifyFiles !== undefined
      && (
        typeof candidate.mayModifyFiles !== 'boolean'
        || (candidate.risk === 'readonly' && candidate.mayModifyFiles)
      )
    )
  ) {
    return {
      risk: 'privileged',
      requiresConfirmation: true
    };
  }

  const description =
    typeof candidate.description === 'string' && candidate.description.trim().length > 0
      ? candidate.description.trim()
      : undefined;
  const inputSchema =
    isJsonSchemaObject(candidate.inputSchema)
      ? candidate.inputSchema
      : undefined;
  const outputSchema =
    isJsonSchemaObject(candidate.outputSchema)
      ? candidate.outputSchema
      : undefined;
  const executionTarget =
    isModuleActionExecutionTarget(candidate.executionTarget)
      ? candidate.executionTarget
      : undefined;
  const timeoutMs =
    Number.isSafeInteger(candidate.timeoutMs)
    && Number(candidate.timeoutMs) > 0
      ? Number(candidate.timeoutMs)
      : undefined;
  const requiredDeviceScopes =
    Array.isArray(candidate.requiredDeviceScopes)
    && candidate.requiredDeviceScopes.length > 0
    && candidate.requiredDeviceScopes.length <= 64
    && candidate.requiredDeviceScopes.every(isValidDeviceScope)
      ? [...new Set(candidate.requiredDeviceScopes)]
      : undefined;

  return {
    ...(description ? { description } : {}),
    risk: candidate.risk,
    requiresConfirmation:
      candidate.risk === 'readonly'
        ? candidate.requiresConfirmation === true
        : true,
    ...(inputSchema ? { inputSchema } : {}),
    ...(outputSchema ? { outputSchema } : {}),
    ...(typeof candidate.idempotent === 'boolean'
      ? { idempotent: candidate.idempotent }
      : {}),
    ...(executionTarget ? { executionTarget } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(requiredDeviceScopes ? { requiredDeviceScopes } : {}),
    ...(typeof candidate.readOnly === 'boolean'
      ? { readOnly: candidate.readOnly }
      : {}),
    ...(typeof candidate.mayModifyFiles === 'boolean'
      ? { mayModifyFiles: candidate.mayModifyFiles }
      : {})
  };
}

function getResolvedModuleActionMetadata(
  mod: ModuleDef
): Record<string, ResolvedModuleActionMetadata> {
  return Object.fromEntries(
    Object.keys(mod.actions).map((action) => [
      action,
      resolveModuleActionMetadata(mod, action)
    ])
  );
}

function isLegacyModuleExposed(mod: ModuleDef): boolean {
  return mod.gptAccessOnly !== true && mod.exposeLegacyRoute !== false;
}

function isTrustedGptAccessModuleContext(
  context: ModuleHandlerContext | undefined
): context is ModuleHandlerContext {
  return Boolean(
    context
    && context.source === 'gpt-access'
    && typeof context.principalId === 'string'
    && context.principalId.trim().length > 0
    && typeof context.workspaceId === 'string'
    && context.workspaceId.trim().length > 0
    && typeof context.actorKey === 'string'
    && context.actorKey.trim().length > 0
  );
}

function resolveRegisteredModule(moduleName: string | undefined): ModuleDef | undefined {
  const mod = typeof moduleName === 'string'
    ? (registryByName.get(moduleName) ?? registryByRoute.get(moduleName))
    : undefined;
  return mod && isLegacyModuleExposed(mod) ? mod : undefined;
}

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
 * Purpose: Register a module definition and mount its handler route.
 * Inputs/Outputs: route string and ModuleDef; mounts handler and caches module metadata.
 * Edge cases: Overwrites existing module entries with the same route or name.
 */
export function registerModule(route: string, mod: ModuleDef) {
  registryByRoute.set(route, mod);
  registryByName.set(mod.name, mod);
  moduleRoutes.set(mod.name, route);
  if (legacyGptRoutesEnabled() && isLegacyModuleExposed(mod)) {
    router.post(`/modules/${route}`, createHandler(mod, route));
  }
}

/**
 * Purpose: Build a safe module registry snapshot for daemon prompts.
 * Inputs/Outputs: None; returns list of module metadata without gptIds.
 * Edge cases: Returns empty list when no modules are loaded.
 */
export function getModulesForRegistry(options: {
  includeActionMetadata?: boolean;
} = {}): Array<{
  id: string;
  description: string | null;
  route: string | null;
  actions: string[];
  actionMetadata?: Record<string, ResolvedModuleActionMetadata>;
}> {
  //audit Assumption: registryByName holds current modules; risk: stale data; invariant: map values used; handling: map to safe shape.
  return Array.from(registryByName.values()).map(mod => ({
    id: mod.name,
    description: mod.description ?? null,
    route: moduleRoutes.get(mod.name) ?? null,
    actions: Object.keys(mod.actions),
    ...(options.includeActionMetadata
      ? { actionMetadata: getResolvedModuleActionMetadata(mod) }
      : {})
  }));
}

/**
 * Purpose: Look up metadata for a single module by name or route.
 * Inputs/Outputs: Module identifier string; returns metadata or null.
 * Edge cases: Returns null when the identifier is not registered.
 */
export function getModuleMetadata(moduleName: string): {
  name: string;
  description: string | null;
  route: string | null;
  actions: string[];
  actionMetadata: Record<string, ResolvedModuleActionMetadata>;
  defaultAction?: string;
  defaultTimeoutMs?: number;
  exposeLegacyRoute?: boolean;
  gptAccessOnly?: boolean;
} | null {
  let mod = registryByName.get(moduleName);
  let route = moduleRoutes.get(moduleName) ?? null;

  if (!mod) {
    mod = registryByRoute.get(moduleName);
    if (mod) {
      route = moduleRoutes.get(mod.name) ?? moduleName;
    }
  }

  if (!mod) return null;

  return {
    name: mod.name,
    description: mod.description ?? null,
    route,
    actions: Object.keys(mod.actions),
    actionMetadata: getResolvedModuleActionMetadata(mod),
    defaultAction: mod.defaultAction,
    defaultTimeoutMs: mod.defaultTimeoutMs,
    exposeLegacyRoute: mod.exposeLegacyRoute,
    gptAccessOnly: mod.gptAccessOnly,
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
  payload: unknown,
  context?: ModuleHandlerContext
): Promise<unknown> {
  const mod = registryByName.get(moduleName);
  if (!mod) throw new ModuleNotFoundError(moduleName);
  const handler = mod.actions[action];
  if (!handler) throw new ModuleActionNotFoundError(action);
  if (
    mod.gptAccessOnly === true
    && !isTrustedGptAccessModuleContext(context)
  ) {
    throw new ModuleAccessDeniedError(moduleName);
  }
  return mod.gptAccessOnly === true
    ? handler(payload, context)
    : handler(payload);
}

router.get('/registry', (_req: Request, res: Response) => {
  const modules = Array.from(registryByName.values())
    .filter(isLegacyModuleExposed)
    .map((mod) => ({
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

  if (!mod || !isLegacyModuleExposed(mod)) {
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
    const mod = resolveRegisteredModule(moduleName);
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
