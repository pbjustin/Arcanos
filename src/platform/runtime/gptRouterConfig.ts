import { loadModuleDefinitions, LoadedModule } from '@services/moduleLoader.js';
import { getEnv } from "@platform/runtime/env.js";
import { assertProtectedConfigIntegrity } from "@services/safety/configIntegrity.js";

interface GptModuleEntry {
  route: string;
  module: string;
}

function buildDefaultBindings(modules: LoadedModule[]): Record<string, GptModuleEntry> {
  const defaults: Record<string, GptModuleEntry> = {};

  for (const { route, definition } of modules) {
    const entry: GptModuleEntry = { route, module: definition.name };
    const ids = Array.isArray(definition.gptIds) && definition.gptIds.length > 0
      ? definition.gptIds
      : [route];

    const normalizedIds = new Set<string>(ids.map((id: string) => id.trim()).filter(Boolean));
    normalizedIds.add(route);

    for (const gptId of normalizedIds) {
      defaults[gptId] = { ...entry };
    }
  }

  return defaults;
}

/**
 * Builds a mapping of GPT IDs to module routes and names.
 *
 * Auto-discovers module definitions from `src/modules` so that any module that
 * declares `gptIds` is automatically routable. The `GPT_MODULE_MAP`
 * environment variable can still override or extend the mapping by providing a
 * JSON object where each key is a GPT ID and the value is an object with
 * `route` and `module` properties. Example:
 *
 * ```bash
 * GPT_MODULE_MAP='{"gpt-1":{"route":"tutor","module":"ARCANOS:TUTOR"}}'
 * ```
 *
 * For backwards compatibility, legacy `GPTID_*` environment variables are also
 * supported. These mappings can be removed once all deployments adopt the new
 * configuration format.
 */
export async function loadGptModuleMap(): Promise<Record<string, GptModuleEntry>> {
  const loadedModules = await loadModuleDefinitions();
  const defaults = buildDefaultBindings(loadedModules);

  const map: Record<string, GptModuleEntry> = { ...defaults };

  // Use config layer for env access (adapter boundary pattern)
  const raw = getEnv('GPT_MODULE_MAP');
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, GptModuleEntry>;
      for (const [gptId, entry] of Object.entries(parsed)) {
        if (entry.route && entry.module) {
          map[gptId] = { ...entry };
        }
      }
    } catch (err) {
      console.warn('Failed to parse GPT_MODULE_MAP', err);
    }
  }

  const moduleRoutesByName = new Map<string, string>();
  for (const { route, definition } of loadedModules) {
    moduleRoutesByName.set(definition.name, route);
  }

  const legacyEntries: Array<[string | undefined, string]> = [
    [getEnv('GPTID_BACKSTAGE_BOOKER'), 'BACKSTAGE:BOOKER'],
    [getEnv('GPTID_ARCANOS_GAMING'), 'ARCANOS:GAMING'],
    [getEnv('GPTID_ARCANOS_TUTOR'), 'ARCANOS:TUTOR'],
  ];

  for (const [id, moduleName] of legacyEntries) {
    if (!id) continue;
    const route = moduleRoutesByName.get(moduleName);
    if (!route) continue;
    map[id] = { route, module: moduleName };
  }

  assertProtectedConfigIntegrity('gpt_router_config', map, {
    source: 'src/platform/runtime/gptRouterConfig.ts'
  });
  return map;
}

let gptModuleMapPromise: Promise<Record<string, GptModuleEntry>> | null = null;

export function getGptModuleMap(): Promise<Record<string, GptModuleEntry>> {
  if (!gptModuleMapPromise) {
    gptModuleMapPromise = loadGptModuleMap();
  }
  return gptModuleMapPromise;
}

export function resetGptModuleMapCache(): void {
  gptModuleMapPromise = null;
}

export default getGptModuleMap;
