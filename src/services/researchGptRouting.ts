import { getGptModuleMap } from '@platform/runtime/gptRouterConfig.js';
import { isProtectedModuleIdentifier } from '@services/moduleCatalog.js';
import { initializeModuleRegistry } from '@services/moduleRegistry.js';
import { validateGptIdentifier } from '@shared/gpt/gptIdentifier.js';
import { resolveGptModuleMapEntry } from '@shared/gpt/gptModuleMapResolution.js';
import { RESEARCH_MODULE_NAME } from '@shared/researchRequest.js';

/**
 * Checks the already-configured GPT map for a Research binding without invoking
 * the unknown-ID recovery/rebuild path. Intended for work-admission preflights.
 */
export async function isRegisteredResearchGptId(gptId: string): Promise<boolean> {
  const validation = validateGptIdentifier(gptId);
  if (!validation.ok || isProtectedModuleIdentifier(validation.value)) {
    return false;
  }

  await initializeModuleRegistry();
  const gptModuleMap = await getGptModuleMap();
  const resolved = resolveGptModuleMapEntry(validation.value, gptModuleMap);
  return resolved?.entry.module === RESEARCH_MODULE_NAME;
}
