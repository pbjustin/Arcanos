import {
  MODULE_CATALOG,
  isProtectedModuleIdentifier,
  isPublicGptModule
} from '@services/moduleCatalog.js';
import { getEnv } from '@platform/runtime/env.js';

export interface GptModuleEntry {
  route: string;
  module: string;
}

export interface GptModuleCandidateDefinition {
  route: string;
  name: string;
  gptIds?: readonly string[];
  gptAccessOnly?: boolean;
}

export interface GptModuleMapCandidateOptions {
  availableModules?: readonly GptModuleCandidateDefinition[];
  onInvalidOverride?: () => void;
  readEnvironment?: (name: string) => string | undefined;
}

function createGptModuleMap(): Record<string, GptModuleEntry> {
  return Object.create(null) as Record<string, GptModuleEntry>;
}

function addBinding(
  map: Record<string, GptModuleEntry>,
  gptId: string,
  entry: GptModuleEntry
): boolean {
  const raw = gptId.trim();
  if (!raw || isProtectedModuleIdentifier(raw)) {
    return false;
  }
  const lower = raw.toLowerCase();
  map[raw] = { ...entry };
  map[lower] = { ...entry };
  return true;
}

function buildDefaultBindings(
  modules: readonly GptModuleCandidateDefinition[]
): Record<string, GptModuleEntry> {
  const defaults = createGptModuleMap();

  for (const entryDefinition of modules) {
    if (!isPublicGptModule(entryDefinition)) {
      continue;
    }
    const { route, name } = entryDefinition;
    const entry: GptModuleEntry = { route, module: name };
    const ids = entryDefinition.gptIds && entryDefinition.gptIds.length > 0
      ? entryDefinition.gptIds
      : [route];

    const normalizedIds = new Set<string>(ids.map((id: string) => id.trim()).filter(Boolean));
    normalizedIds.add(route);
    for (const gptId of normalizedIds) {
      addBinding(defaults, gptId, entry);
    }
  }
  return defaults;
}

/**
 * Build the effective GPT route candidate from immutable catalog metadata and
 * the supplied environment reader. Runtime callers narrow the catalog to the
 * identities that loaded successfully; pre-cutover tooling uses the complete
 * build-validated catalog. This function does not initialize modules or touch
 * integrity, quarantine, audit, provider, database, or filesystem state.
 */
export async function buildGptModuleMapCandidate(
  options: GptModuleMapCandidateOptions = {}
): Promise<Record<string, GptModuleEntry>> {
  const readEnvironment = options.readEnvironment ?? getEnv;
  const effectiveModules: readonly GptModuleCandidateDefinition[] =
    options.availableModules ?? MODULE_CATALOG;
  const defaults = buildDefaultBindings(effectiveModules);
  const map = Object.assign(createGptModuleMap(), defaults);
  const moduleRoutesByName = new Map<string, string>();
  const publicModuleRoutesByName = new Map<string, string>();
  for (const { route, name, ...exposure } of effectiveModules) {
    moduleRoutesByName.set(name, route);
    if (isPublicGptModule(exposure)) {
      publicModuleRoutesByName.set(name, route);
    }
  }

  const raw = readEnvironment('GPT_MODULE_MAP');
  if (raw) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      if (options.onInvalidOverride) {
        options.onInvalidOverride();
      } else {
        console.warn('Failed to parse GPT_MODULE_MAP');
      }
    }

    if (
      parsed !== undefined
      && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    ) {
      if (options.onInvalidOverride) {
        options.onInvalidOverride();
      } else {
        console.warn('Failed to parse GPT_MODULE_MAP');
      }
      parsed = undefined;
    }

    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [gptId, candidate] of Object.entries(parsed)) {
        if (
          !candidate
          || typeof candidate !== 'object'
          || Array.isArray(candidate)
        ) {
          options.onInvalidOverride?.();
          continue;
        }
        const entry = candidate as Record<string, unknown>;
        if (
          typeof entry.route === 'string'
          && typeof entry.module === 'string'
          && !isProtectedModuleIdentifier(entry.module)
          && !isProtectedModuleIdentifier(entry.route)
          && publicModuleRoutesByName.get(entry.module) === entry.route
        ) {
          if (addBinding(map, gptId, {
            route: entry.route,
            module: entry.module
          })) {
            continue;
          }
        }
        options.onInvalidOverride?.();
      }
    }
  }

  const legacyEntries: Array<[string | undefined, string]> = [
    [readEnvironment('GPTID_BACKSTAGE_BOOKER'), 'BACKSTAGE:BOOKER'],
    [readEnvironment('GPTID_ARCANOS_GAMING'), 'ARCANOS:GAMING'],
    [readEnvironment('GPTID_ARCANOS_TUTOR'), 'ARCANOS:TUTOR']
  ];

  for (const [id, moduleName] of legacyEntries) {
    if (!id) {
      continue;
    }
    const route = moduleRoutesByName.get(moduleName);
    if (!route) {
      options.onInvalidOverride?.();
      continue;
    }
    if (!addBinding(map, id, { route, module: moduleName })) {
      options.onInvalidOverride?.();
    }
  }

  return map;
}
