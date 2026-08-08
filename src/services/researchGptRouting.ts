import { getEnv } from '@platform/runtime/env.js';
import {
  isProtectedModuleIdentifier,
  isPublicGptModule,
  MODULE_CATALOG,
} from '@services/moduleCatalog.js';
import { validateGptIdentifier } from '@shared/gpt/gptIdentifier.js';
import { resolveGptModuleMapEntry } from '@shared/gpt/gptModuleMapResolution.js';
import { RESEARCH_MODULE_NAME } from '@shared/researchRequest.js';

const RESEARCH_ROUTE = 'research';
const BUILT_IN_RESEARCH_GPT_IDS = ['arcanos-research', RESEARCH_ROUTE] as const;
type ResearchCandidateEntry = { route: string; module: string };
type ConfiguredBindingDisposition = 'defer' | 'non-research' | 'research';

const PUBLIC_CATALOG_ROUTES_BY_MODULE = new Map(
  MODULE_CATALOG
    .filter(isPublicGptModule)
    .map((entry) => [entry.name, entry.route] as const),
);

function addResearchCandidate(
  candidates: Record<string, ResearchCandidateEntry>,
  gptId: string,
): void {
  const trimmed = gptId.trim();
  if (!trimmed || isProtectedModuleIdentifier(trimmed)) {
    return;
  }

  const entry = { route: RESEARCH_ROUTE, module: RESEARCH_MODULE_NAME };
  candidates[trimmed] = entry;
  candidates[trimmed.toLowerCase()] = entry;
}

function classifyConfiguredBinding(candidate: unknown): ConfiguredBindingDisposition {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return 'defer';
  }

  const entry = candidate as Record<string, unknown>;
  if (
    typeof entry.route !== 'string'
    || typeof entry.module !== 'string'
    || isProtectedModuleIdentifier(entry.route)
    || isProtectedModuleIdentifier(entry.module)
    || PUBLIC_CATALOG_ROUTES_BY_MODULE.get(entry.module) !== entry.route
  ) {
    return 'defer';
  }

  return entry.module === RESEARCH_MODULE_NAME ? 'research' : 'non-research';
}

function addConfiguredBindingDisposition(
  dispositions: Map<string, ConfiguredBindingDisposition>,
  gptId: string,
  disposition: ConfiguredBindingDisposition,
): void {
  const trimmed = gptId.trim();
  if (!trimmed || isProtectedModuleIdentifier(trimmed)) {
    return;
  }

  dispositions.set(trimmed, disposition);
  dispositions.set(trimmed.toLowerCase(), disposition);
}

function buildResearchCandidateState(): {
  candidates: Record<string, ResearchCandidateEntry>;
  configuredBindings: Map<string, ConfiguredBindingDisposition>;
} {
  const candidates = Object.create(null) as Record<string, ResearchCandidateEntry>;
  const configuredBindings = new Map<string, ConfiguredBindingDisposition>();
  for (const gptId of BUILT_IN_RESEARCH_GPT_IDS) {
    addResearchCandidate(candidates, gptId);
  }

  const configuredMap = getEnv('GPT_MODULE_MAP');
  if (!configuredMap) {
    return { candidates, configuredBindings };
  }

  try {
    const parsed = JSON.parse(configuredMap) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { candidates, configuredBindings };
    }

    for (const [gptId, candidate] of Object.entries(parsed)) {
      const disposition = classifyConfiguredBinding(candidate);
      addConfiguredBindingDisposition(configuredBindings, gptId, disposition);
      if (disposition === 'research') {
        addResearchCandidate(candidates, gptId);
      }
    }
  } catch {
    return { candidates, configuredBindings };
  }

  return { candidates, configuredBindings };
}

/**
 * Rejects IDs that cannot target Research before lazily checking the configured
 * GPT map. The authoritative check does not invoke unknown-ID recovery/rebuild.
 * Intended for work-admission preflights.
 */
export async function isRegisteredResearchGptId(gptId: string): Promise<boolean> {
  const validation = validateGptIdentifier(gptId);
  if (!validation.ok || isProtectedModuleIdentifier(validation.value)) {
    return false;
  }

  const candidateState = buildResearchCandidateState();
  const configuredDisposition =
    candidateState.configuredBindings.get(validation.value)
    ?? candidateState.configuredBindings.get(validation.value.toLowerCase());
  if (configuredDisposition === 'non-research') {
    return false;
  }

  const candidate = resolveGptModuleMapEntry(
    validation.value,
    candidateState.candidates,
  );
  if (
    configuredDisposition !== 'defer'
    && candidate?.entry.module !== RESEARCH_MODULE_NAME
  ) {
    return false;
  }

  const { getGptModuleMap } = await import('@platform/runtime/gptRouterConfig.js');
  const gptModuleMap = await getGptModuleMap();
  const resolved = resolveGptModuleMapEntry(validation.value, gptModuleMap);
  return resolved?.entry.module === RESEARCH_MODULE_NAME;
}
