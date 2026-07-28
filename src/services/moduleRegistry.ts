import {
  loadModuleDefinitions,
  type LoadedModule,
  type ModuleActionExecutionTarget,
  type ModuleActionMetadata,
  type ModuleActionRisk,
  type ModuleDef,
  type ModuleHandlerContext
} from './moduleLoader.js';
import { isLegacyModuleExposed } from './moduleCatalog.js';

export type ResolvedModuleActionMetadata = ModuleActionMetadata & {
  requiresConfirmation: boolean;
};

export interface RegisteredModule {
  readonly route: string;
  readonly definition: ModuleDef;
}

export interface ModuleRegistryEntry {
  id: string;
  description: string | null;
  route: string | null;
  actions: string[];
  actionMetadata?: Record<string, ResolvedModuleActionMetadata>;
}

export interface PublicModuleRegistryEntry {
  name: string;
  description: string | null;
  route: string;
  actions: string[];
  gptIds: string[];
}

export interface ModuleMetadata {
  name: string;
  description: string | null;
  route: string | null;
  actions: string[];
  actionMetadata: Record<string, ResolvedModuleActionMetadata>;
  defaultAction?: string;
  defaultTimeoutMs?: number;
  exposeLegacyRoute?: boolean;
  gptAccessOnly?: boolean;
}

export interface ModuleRegistry {
  listRegisteredModules(): RegisteredModule[];
  getModulesForRegistry(options?: {
    includeActionMetadata?: boolean;
  }): ModuleRegistryEntry[];
  getPublicModulesForRegistry(): PublicModuleRegistryEntry[];
  getModuleMetadata(moduleName: string): ModuleMetadata | null;
  resolveRegisteredModule(moduleName: string): RegisteredModule | null;
  dispatchModuleAction(
    moduleName: string,
    action: string,
    payload: unknown,
    context?: ModuleHandlerContext
  ): Promise<unknown>;
}

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

/**
 * Creates one immutable registry generation from validated loader output.
 * Definitions are loader-owned immutable snapshots; callers receive fresh
 * entry wrappers and summary arrays rather than the registry's internal maps.
 */
export function createModuleRegistry(
  loadedModules: readonly LoadedModule[]
): ModuleRegistry {
  const registryByRoute = new Map<string, ModuleDef>();
  const registryByName = new Map<string, ModuleDef>();
  const moduleRoutes = new Map<string, string>();
  const registeredModules = Object.freeze(
    loadedModules.map(({ route, definition }) => {
      if (registryByRoute.has(route)) {
        throw new Error(`Duplicate registered module route: ${route}`);
      }
      if (registryByName.has(definition.name)) {
        throw new Error(`Duplicate registered module name: ${definition.name}`);
      }

      registryByRoute.set(route, definition);
      registryByName.set(definition.name, definition);
      moduleRoutes.set(definition.name, route);
      return Object.freeze({ route, definition });
    })
  );

  function resolveRegisteredModule(
    moduleName: string
  ): RegisteredModule | null {
    const byName = registryByName.get(moduleName);
    if (byName) {
      return {
        route: moduleRoutes.get(byName.name) ?? moduleName,
        definition: byName
      };
    }

    const byRoute = registryByRoute.get(moduleName);
    if (!byRoute) {
      return null;
    }

    return {
      route: moduleRoutes.get(byRoute.name) ?? moduleName,
      definition: byRoute
    };
  }

  function getModulesForRegistry(options: {
    includeActionMetadata?: boolean;
  } = {}): ModuleRegistryEntry[] {
    return registeredModules.map(({ route, definition }) => ({
      id: definition.name,
      description: definition.description ?? null,
      route,
      actions: Object.keys(definition.actions),
      ...(options.includeActionMetadata
        ? { actionMetadata: getResolvedModuleActionMetadata(definition) }
        : {})
    }));
  }

  function getPublicModulesForRegistry(): PublicModuleRegistryEntry[] {
    return registeredModules
      .filter(({ definition }) => isLegacyModuleExposed(definition))
      .map(({ route, definition }) => ({
        name: definition.name,
        description: definition.description ?? null,
        route,
        actions: Object.keys(definition.actions),
        gptIds: definition.gptIds ? [...definition.gptIds] : []
      }));
  }

  function getModuleMetadata(moduleName: string): ModuleMetadata | null {
    const registered = resolveRegisteredModule(moduleName);
    if (!registered) {
      return null;
    }

    const { definition, route } = registered;
    return {
      name: definition.name,
      description: definition.description ?? null,
      route,
      actions: Object.keys(definition.actions),
      actionMetadata: getResolvedModuleActionMetadata(definition),
      defaultAction: definition.defaultAction,
      defaultTimeoutMs: definition.defaultTimeoutMs,
      exposeLegacyRoute: definition.exposeLegacyRoute,
      gptAccessOnly: definition.gptAccessOnly
    };
  }

  async function dispatchModuleAction(
    moduleName: string,
    action: string,
    payload: unknown,
    context?: ModuleHandlerContext
  ): Promise<unknown> {
    const mod = registryByName.get(moduleName);
    if (!mod) {
      throw new ModuleNotFoundError(moduleName);
    }
    const handler = mod.actions[action];
    if (!handler) {
      throw new ModuleActionNotFoundError(action);
    }
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

  return Object.freeze({
    listRegisteredModules: () =>
      registeredModules.map(({ route, definition }) => ({ route, definition })),
    getModulesForRegistry,
    getPublicModulesForRegistry,
    getModuleMetadata,
    resolveRegisteredModule,
    dispatchModuleAction
  });
}

let defaultModuleRegistry: ModuleRegistry | null = null;
let moduleRegistryInitialization: Promise<ModuleRegistry> | null = null;

/**
 * Loads the process-wide registry generation once. Concurrent callers share
 * the same initialization attempt, while a failed attempt remains retryable.
 */
export function initializeModuleRegistry(): Promise<ModuleRegistry> {
  if (defaultModuleRegistry) {
    return Promise.resolve(defaultModuleRegistry);
  }
  if (!moduleRegistryInitialization) {
    moduleRegistryInitialization = loadModuleDefinitions()
      .then((loadedModules) => {
        const registry = createModuleRegistry(loadedModules);
        defaultModuleRegistry = registry;
        return registry;
      })
      .finally(() => {
        moduleRegistryInitialization = null;
      });
  }
  return moduleRegistryInitialization;
}

function getInitializedModuleRegistry(): ModuleRegistry {
  if (!defaultModuleRegistry) {
    throw new Error(
      'Module registry is not initialized. Call initializeModuleRegistry() first.'
    );
  }
  return defaultModuleRegistry;
}

export function listRegisteredModules(): RegisteredModule[] {
  return getInitializedModuleRegistry().listRegisteredModules();
}

export function getModulesForRegistry(options: {
  includeActionMetadata?: boolean;
} = {}): ModuleRegistryEntry[] {
  return getInitializedModuleRegistry().getModulesForRegistry(options);
}

export function getPublicModulesForRegistry(): PublicModuleRegistryEntry[] {
  return getInitializedModuleRegistry().getPublicModulesForRegistry();
}

export function getModuleMetadata(moduleName: string): ModuleMetadata | null {
  return getInitializedModuleRegistry().getModuleMetadata(moduleName);
}

export function resolveRegisteredModule(
  moduleName: string
): RegisteredModule | null {
  return getInitializedModuleRegistry().resolveRegisteredModule(moduleName);
}

export function resolveLegacyModule(
  moduleName: string | undefined
): RegisteredModule | null {
  if (typeof moduleName !== 'string') {
    return null;
  }
  const registered = resolveRegisteredModule(moduleName);
  return registered && isLegacyModuleExposed(registered.definition)
    ? registered
    : null;
}

export function dispatchModuleAction(
  moduleName: string,
  action: string,
  payload: unknown,
  context?: ModuleHandlerContext
): Promise<unknown> {
  return getInitializedModuleRegistry().dispatchModuleAction(
    moduleName,
    action,
    payload,
    context
  );
}
