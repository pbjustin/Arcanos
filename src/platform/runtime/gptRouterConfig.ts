import { getEnv } from '@platform/runtime/env.js';
import { INTEGRITY_MANIFEST } from '@platform/runtime/integrityManifest.js';
import {
  buildGptModuleMapCandidate,
  type GptModuleEntry
} from '@platform/runtime/gptRouterCandidate.js';
import {
  MODULE_CATALOG,
  isPublicGptModule
} from '@services/moduleCatalog.js';
import { assertProtectedConfigIntegrity } from '@services/safety/configIntegrity.js';
import {
  initializeModuleRegistry,
  type RegisteredModule
} from '@services/moduleRegistry.js';

export {
  buildGptModuleMapCandidate,
  type GptModuleEntry,
  type GptModuleMapCandidateOptions
} from '@platform/runtime/gptRouterCandidate.js';

export interface GptRegistryValidation {
  requiredGptIds: string[];
  missingGptIds: string[];
  registeredGptIds: string[];
  registeredGptCount: number;
}

const DEFAULT_REQUIRED_GPT_IDS = ['arcanos-core', 'core'] as const;

function normalizeGptIdList(values: Iterable<string | null | undefined>): string[] {
  const uniqueIds = new Map<string, string>();
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.toLowerCase();
    if (!uniqueIds.has(normalized)) {
      uniqueIds.set(normalized, trimmed);
    }
  }

  return Array.from(uniqueIds.values()).sort((left, right) => left.localeCompare(right));
}

export function getRequiredGptIds(): string[] {
  const configured =
    getEnv('REQUIRED_GPT_IDS') ??
    getEnv('GPT_REQUIRED_IDS') ??
    '';

  if (!configured.trim()) {
    return [...DEFAULT_REQUIRED_GPT_IDS];
  }

  return normalizeGptIdList(configured.split(','));
}

export function listRegisteredGptIds(map: Record<string, GptModuleEntry>): string[] {
  return normalizeGptIdList(Object.keys(map));
}

export function validateGptRegistry(
  map: Record<string, GptModuleEntry>,
  requiredGptIds: string[] = getRequiredGptIds()
): GptRegistryValidation {
  const normalizedRegisteredIds = new Set(Object.keys(map).map((id) => id.trim().toLowerCase()).filter(Boolean));
  const registeredGptIds = listRegisteredGptIds(map);
  const missingGptIds = normalizeGptIdList(
    requiredGptIds.filter((requiredId) => !normalizedRegisteredIds.has(requiredId.trim().toLowerCase()))
  );

  return {
    requiredGptIds: normalizeGptIdList(requiredGptIds),
    missingGptIds,
    registeredGptIds,
    registeredGptCount: registeredGptIds.length
  };
}

function hasImmutableGptRouterPin(): boolean {
  const entry = INTEGRITY_MANIFEST.gpt_router_config;
  return Boolean(
    getEnv(entry.expectedHashEnv)?.trim()
    || entry.builtInExpectedHash?.trim()
  );
}

function assertPinnedPublicCatalogIsRegistered(
  registeredModules: readonly RegisteredModule[]
): void {
  if (!hasImmutableGptRouterPin()) {
    return;
  }

  const expectedIdentities = MODULE_CATALOG
    .filter(isPublicGptModule)
    .map(({ route, name }) => `${route}\u0000${name}`)
    .sort((left, right) => left.localeCompare(right));
  const registeredIdentities = registeredModules
    .filter(({ definition }) => isPublicGptModule(definition))
    .map(({ route, definition }) => `${route}\u0000${definition.name}`)
    .sort((left, right) => left.localeCompare(right));

  if (
    expectedIdentities.length !== registeredIdentities.length
    || expectedIdentities.some(
      (identity, index) => identity !== registeredIdentities[index]
    )
  ) {
    throw new Error(
      'Pinned GPT router configuration requires the complete public module catalog.'
    );
  }
}

export async function loadGptModuleMap(): Promise<Record<string, GptModuleEntry>> {
  const registeredModules = (
    await initializeModuleRegistry()
  ).listRegisteredModules();
  const map = await buildGptModuleMapCandidate({
    availableModules: registeredModules.map(({ route, definition }) => ({
      route,
      name: definition.name,
      gptIds: definition.gptIds,
      gptAccessOnly: definition.gptAccessOnly
    }))
  });
  const immutablePinConfigured = hasImmutableGptRouterPin();
  const integrityCandidate = await buildGptModuleMapCandidate({
    onInvalidOverride: immutablePinConfigured
      ? () => {
          throw new Error(
            'Pinned GPT router configuration contains an invalid override.'
          );
        }
      : () => undefined
  });
  assertProtectedConfigIntegrity('gpt_router_config', integrityCandidate, {
    source: 'src/platform/runtime/gptRouterConfig.ts'
  });
  assertPinnedPublicCatalogIsRegistered(registeredModules);
  return map;
}

let gptModuleMapPromise: Promise<Record<string, GptModuleEntry>> | null = null;

export function getGptModuleMap(): Promise<Record<string, GptModuleEntry>> {
  if (!gptModuleMapPromise) {
    gptModuleMapPromise = loadGptModuleMap().catch((error) => {
      gptModuleMapPromise = null;
      throw error;
    });
  }
  return gptModuleMapPromise;
}

export function resetGptModuleMapCache(): void {
  gptModuleMapPromise = null;
}

export async function rebuildGptModuleMap(): Promise<Record<string, GptModuleEntry>> {
  resetGptModuleMapCache();
  return getGptModuleMap();
}

export async function getGptRegistrySnapshot(): Promise<{
  map: Record<string, GptModuleEntry>;
  validation: GptRegistryValidation;
}> {
  const map = await getGptModuleMap();
  return {
    map,
    validation: validateGptRegistry(map)
  };
}

export default getGptModuleMap;
