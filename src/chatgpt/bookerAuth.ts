import { getEnv } from '@platform/runtime/env.js';
import {
  readBookerAuthConfigurationCore, createBookerTokenVerifierCore, type ReadyBookerAuthConfiguration,
} from './bookerAuthCore.js';
import type { EnvironmentReader } from './authCore.js';

export * from './bookerAuthCore.js';

export function readBookerAuthConfiguration(read: EnvironmentReader = getEnv) {
  return readBookerAuthConfigurationCore(read);
}

export function createBookerTokenVerifier(config: ReadyBookerAuthConfiguration,
  options: Partial<Parameters<typeof createBookerTokenVerifierCore>[1]> = {}) {
  return createBookerTokenVerifierCore(config, { ...options, readEnvironmentValue: options.readEnvironmentValue ?? getEnv });
}
