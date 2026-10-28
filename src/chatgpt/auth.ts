import { getEnv } from '@platform/runtime/env.js';
import type { JWTVerifyGetKey } from 'jose';
import {
  readChatGptAuthConfigurationCore, createChatGptTokenVerifierCore, createScopedChatGptTokenVerifierCore,
  type EnvironmentReader, type ReadyChatGptAuthConfiguration,
} from './authCore.js';

export * from './authCore.js';

/** Production defaults retain the shared verifier's single trusted-principal registry. */
export function readChatGptAuthConfiguration(readEnvironmentValue: EnvironmentReader = getEnv) {
  return readChatGptAuthConfigurationCore(readEnvironmentValue);
}

export function createChatGptTokenVerifier(config: ReadyChatGptAuthConfiguration,
  options: { keyResolver?: JWTVerifyGetKey; readEnvironmentValue?: EnvironmentReader } = {}) {
  return createChatGptTokenVerifierCore(config, { ...options, readEnvironmentValue: options.readEnvironmentValue ?? getEnv });
}

export function createScopedChatGptTokenVerifier(config: ReadyChatGptAuthConfiguration,
  policy: Parameters<typeof createScopedChatGptTokenVerifierCore>[1],
  options: { keyResolver?: JWTVerifyGetKey; readEnvironmentValue?: EnvironmentReader } = {}) {
  return createScopedChatGptTokenVerifierCore(config, policy, { ...options, readEnvironmentValue: options.readEnvironmentValue ?? getEnv });
}
