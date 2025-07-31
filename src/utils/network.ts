import { createServiceLogger } from './logger';
import { isTrue } from './env';

const logger = createServiceLogger('Network');

export function networkAllowed(): boolean {
  const flag = process.env.ALLOW_NETWORK;
  const allow = flag === undefined ? true : isTrue(flag);
  if (!allow) {
    logger.warning('Network access disabled via ALLOW_NETWORK');
  }
  return allow;
}
