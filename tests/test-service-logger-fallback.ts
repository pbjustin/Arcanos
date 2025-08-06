import assert from 'node:assert';
import { createServiceLogger } from '../src_original/utils/logger.js';

const logger: any = createServiceLogger('TestService');

const infoMessages: string[] = [];
const warnMessages: string[] = [];

const origLog = console.log;
const origWarn = console.warn;

try {
  console.log = (msg: any) => infoMessages.push(String(msg));
  console.warn = (msg: any) => warnMessages.push(String(msg));
  logger.unknown('This should trigger fallback logic');
} finally {
  console.log = origLog;
  console.warn = origWarn;
}

assert(
  warnMessages.some(m => m.includes('Unknown log level "unknown"')),
  'Should warn about unknown log level'
);
assert(
  infoMessages.some(m => m.includes('This should trigger fallback logic')),
  'Should log original message at info level'
);

console.log('Fallback logging test passed');
