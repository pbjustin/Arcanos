import { getMemory, saveMemory } from './memory';
import { aiDispatcher } from './ai-dispatcher';

interface GuideOptions {
  defaultAction: string;
  format: string;
  source: string;
}

const guideRegistry = new Map<string, GuideOptions>();

export function registerGuide(key: string, options: GuideOptions): void {
  guideRegistry.set(key, options);
}

/**
 * Normalize any guide or content block for readability.
 * Retrieves memory, flattens nested structures, stores a render-friendly version,
 * and dispatches a render task via the AI dispatcher.
 */
export async function normalizeContentBlock(key: string) {
  registerGuide(key, {
    defaultAction: 'read',
    format: 'markdown',
    source: `memory.${key}`,
  });

  let raw = await getMemory(key);
  if (typeof raw === 'function') {
    raw = raw();
  }
  if (Array.isArray(raw)) {
    raw = raw.flat(Infinity).join('\n');
  }

  await saveMemory(`${key}.render`, raw);

  return aiDispatcher.dispatch({
    type: 'internal',
    payload: {
      task: 'renderContent',
      data: raw,
      format: 'markdown',
    },
  });
}
