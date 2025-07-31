import { createServiceLogger } from './logger';
import { networkAllowed } from './network';

const logger = createServiceLogger('ModuleLoader');

export function safeImport<T = any>(moduleName: string): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(moduleName) as T;
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
