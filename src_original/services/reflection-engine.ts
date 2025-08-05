import { reflect } from './ai/index.js';
import { createServiceLogger } from '../utils/logger.js';

export interface ReflectionTriggerOptions {
  source?: string;
  force?: boolean;
  log?: boolean;
  memoryTarget?: string;
}

const logger = createServiceLogger('ReflectionEngine');

export async function triggerSelfReflection(options: ReflectionTriggerOptions = {}): Promise<void> {
  const { source = 'manual', log = false, memoryTarget = 'long-term' } = options;

  try {
    const snapshot = await reflect({
      label: `${source}_reflection_${Date.now()}`,
      persist: true,
      includeStack: true,
      targetPath: `ai_outputs/reflections/${memoryTarget}/`
    });

    if (log) {
      logger.info(`Reflection completed from ${source}`, { timestamp: snapshot.timestamp });
    }
  } catch (error: any) {
    logger.error(`Reflection failed from ${source}`, error);
  }
}
