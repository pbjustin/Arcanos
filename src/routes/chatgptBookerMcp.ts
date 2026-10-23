import type { RequestHandler } from 'express';
import { config as runtimeConfig } from '@platform/runtime/config.js';
import { getEnv } from '@platform/runtime/env.js';
import { publicProviderRateLimit, resolvePublicProviderClientIdentity } from '@transport/http/middleware/publicProviderAdmission.js';
import { hasUnsafeBlockingConditions } from '@services/safety/runtimeState.js';
import { createBookerTokenVerifier, readBookerAuthConfiguration, type BookerAuthConfiguration } from '../chatgpt/bookerAuth.js';
import { executeBookerMcp } from '../chatgpt/booker.js';
import { runWithBookerMcpProviderAdmission } from '../chatgpt/bookerRequestAuth.js';
import { createChatGptBookerMcpRouterCore } from './chatgptBookerMcpCore.js';

/** Dedicated production Booker resource with unchanged runtime defaults. */
export function createChatGptBookerMcpRouter(options: {
  configuration?: BookerAuthConfiguration;
  verification?: Parameters<typeof createBookerTokenVerifier>[1];
  execute?: typeof executeBookerMcp;
  providerAdmission?: RequestHandler;
  timeoutMs?: number;
} = {}) {
  return createChatGptBookerMcpRouterCore({
    configuration: options.configuration ?? readBookerAuthConfiguration(),
    verification: { ...options.verification, readEnvironmentValue: options.verification?.readEnvironmentValue ?? getEnv },
    execute: options.execute ?? executeBookerMcp,
    providerAdmission: options.providerAdmission ?? publicProviderRateLimit,
    resolveClientIdentity: req => resolvePublicProviderClientIdentity(req,
      { trustRailwayRealIp: runtimeConfig.limits.publicProviderTrustRailwayRealIp }),
    hasUnsafeBlockingConditions,
    runWithProviderAdmission: runWithBookerMcpProviderAdmission,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
