import { logger } from '@platform/logging/structuredLogging.js';
import {
  defineModuleCatalog,
  MODULE_CATALOG,
  type ModuleCatalogEntry
} from './moduleCatalog.js';

export type ModuleActionRisk = 'readonly' | 'privileged' | 'destructive';
export type ModuleActionExecutionTarget = 'typescript' | 'python-daemon';

export interface ModuleHandlerContext {
  source: 'gpt-access';
  principalId: string;
  workspaceId: string;
  actorKey: string;
  requestId?: string;
  traceId?: string | null;
  idempotencyKey?: string;
  confirmation?: {
    status: string;
    usedChallengeToken: boolean;
  };
}

export interface ModuleActionMetadata {
  description?: string;
  risk: ModuleActionRisk;
  requiresConfirmation?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  idempotent?: boolean;
  executionTarget?: ModuleActionExecutionTarget;
  timeoutMs?: number;
  requiredDeviceScopes?: string[];
  readOnly?: boolean;
  mayModifyFiles?: boolean;
}

export type ModuleActionHandler = (
  payload: unknown,
  context?: ModuleHandlerContext
) => Promise<unknown>;

export interface ModuleDef {
  name: string;
  description?: string;
  actions: Record<string, ModuleActionHandler>;
  actionMetadata?: Record<string, ModuleActionMetadata>;
  gptIds?: string[];
  defaultAction?: string;
  defaultTimeoutMs?: number;
  exposeLegacyRoute?: boolean;
  gptAccessOnly?: boolean;
}

export interface LoadedModule {
  readonly route: string;
  readonly definition: ModuleDef;
}

export type ModuleImporter = (source: string) => Promise<unknown>;

export interface ModuleDefinitionLoader {
  load(): Promise<LoadedModule[]>;
  clear(): void;
}

type ModuleDefinitionRejection =
  | 'missing_default'
  | 'name_mismatch'
  | 'invalid_actions'
  | 'exposure_mismatch';

type LoadedModuleSnapshot = Readonly<LoadedModule>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getModuleDefinitionRejection(
  value: unknown,
  entry: ModuleCatalogEntry
): ModuleDefinitionRejection | null {
  if (!isRecord(value)) {
    return 'missing_default';
  }
  if (value.name !== entry.name) {
    return 'name_mismatch';
  }

  const actions = value.actions;
  if (
    !isRecord(actions)
    || Object.keys(actions).length === 0
    || !Object.values(actions).every((handler) => typeof handler === 'function')
  ) {
    return 'invalid_actions';
  }
  const expectedGptAccessOnly = entry.gptAccessOnly === true;
  if (
    (value.gptAccessOnly === true) !== expectedGptAccessOnly
    || (
      expectedGptAccessOnly
      && value.exposeLegacyRoute !== false
    )
  ) {
    return 'exposure_mismatch';
  }

  return null;
}

function cloneAndFreezeMetadataValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => cloneAndFreezeMetadataValue(entry))
    );
  }
  if (isRecord(value)) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          cloneAndFreezeMetadataValue(entry)
        ])
      )
    );
  }
  return value;
}

function createModuleDefinitionSnapshot(value: unknown): ModuleDef {
  const definition = value as ModuleDef;
  return Object.freeze({
    ...definition,
    actions: Object.freeze({ ...definition.actions }),
    ...(definition.actionMetadata
      ? {
          actionMetadata: cloneAndFreezeMetadataValue(
            definition.actionMetadata
          ) as Record<string, ModuleActionMetadata>
        }
      : {}),
    ...(definition.gptIds
      ? {
          gptIds: Object.freeze(
            [...definition.gptIds]
          ) as unknown as string[]
        }
      : {})
  }) as ModuleDef;
}

function cloneLoadedModules(
  modules: readonly LoadedModuleSnapshot[]
): LoadedModule[] {
  return modules.map(({ route, definition }) => ({ route, definition }));
}

async function loadCatalogSnapshot(
  catalog: readonly ModuleCatalogEntry[],
  importModule: ModuleImporter
): Promise<readonly LoadedModuleSnapshot[]> {
  const loaded: LoadedModuleSnapshot[] = [];

  for (const entry of catalog) {
    let imported: unknown;
    try {
      imported = await importModule(entry.source);
    } catch {
      logger.error('module.catalog.entry_unavailable', {
        module: 'module-loader',
        operation: 'import',
        route: entry.route,
        expectedModule: entry.name,
        source: entry.source,
        reason: 'import_failed'
      });
      continue;
    }

    const candidate = isRecord(imported) ? imported.default : undefined;
    const rejection = getModuleDefinitionRejection(candidate, entry);
    if (rejection) {
      logger.error('module.catalog.entry_unavailable', {
        module: 'module-loader',
        operation: 'validate',
        route: entry.route,
        expectedModule: entry.name,
        source: entry.source,
        reason: rejection
      });
      continue;
    }

    loaded.push(Object.freeze({
      route: entry.route,
      definition: createModuleDefinitionSnapshot(candidate)
    }));
  }

  return Object.freeze(loaded);
}

async function importCatalogModule(source: string): Promise<unknown> {
  return import(source);
}

/**
 * Creates an isolated catalog loader. The factory keeps discovery testable
 * without importing unrelated service files or mutating the process-wide cache.
 */
export function createModuleDefinitionLoader(
  catalog: readonly ModuleCatalogEntry[],
  importModule: ModuleImporter = importCatalogModule
): ModuleDefinitionLoader {
  const ownedCatalog = defineModuleCatalog(catalog);
  let cachedModules: readonly LoadedModuleSnapshot[] | null = null;
  let loadingPromise: Promise<readonly LoadedModuleSnapshot[]> | null = null;
  let cacheGeneration = 0;

  return {
    async load(): Promise<LoadedModule[]> {
      if (cachedModules) {
        return cloneLoadedModules(cachedModules);
      }

      if (!loadingPromise) {
        const loadGeneration = cacheGeneration;
        let currentLoad: Promise<readonly LoadedModuleSnapshot[]>;
        currentLoad = loadCatalogSnapshot(ownedCatalog, importModule)
          .then((loaded) => {
            if (cacheGeneration === loadGeneration) {
              cachedModules = loaded;
            }
            return loaded;
          })
          .finally(() => {
            if (loadingPromise === currentLoad) {
              loadingPromise = null;
            }
          });
        loadingPromise = currentLoad;
      }

      return cloneLoadedModules(await loadingPromise);
    },

    clear(): void {
      cacheGeneration += 1;
      cachedModules = null;
      loadingPromise = null;
    }
  };
}

const defaultModuleDefinitionLoader = createModuleDefinitionLoader(MODULE_CATALOG);

export function loadModuleDefinitions(): Promise<LoadedModule[]> {
  return defaultModuleDefinitionLoader.load();
}

/**
 * Clears only the validated registry snapshot. Node's ESM evaluation cache is
 * process-owned, so source changes or evaluation failures require a restart.
 */
export function clearModuleDefinitionCache(): void {
  defaultModuleDefinitionLoader.clear();
}
