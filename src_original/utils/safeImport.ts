import { createServiceLogger } from './logger.js';
import { networkAllowed } from './network.js';

const logger = createServiceLogger('ModuleLoader');

export async function safeImport<T = any>(moduleName: string): Promise<T | null> {
  try {
    return (await import(moduleName)) as T;
  } catch (err: any) {
    if (err.code === 'MODULE_NOT_FOUND') {
      logger.error(`Module "${moduleName}" not found`, err);
      logger.info(`Install with: npm install ${moduleName}`);
      if (!networkAllowed()) {
        logger.warning('Network access is disabled - installation may fail.');
      }
    } else {
      logger.error(`Failed loading module "${moduleName}"`, err);
    }
    return null;
  }
}
