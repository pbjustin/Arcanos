import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('Studio');

export interface StudioLog {
  action: string;
  source: string;
  result?: any;
  error?: any;
  timestamp: string;
}

export function logToStudio(log: StudioLog): void {
  const { action, source, result, error, timestamp } = log;
  const context = { result, error, timestamp };
  logger.info(`${source} - ${action}`, context);
}
