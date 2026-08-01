import { afterEach, describe, expect, it, jest } from '@jest/globals';

const ENVIRONMENT_NAMES = [
  'PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP',
  'RAILWAY_PROJECT_ID',
  'RAILWAY_ENVIRONMENT_ID',
  'RAILWAY_SERVICE_ID',
] as const;

const originalEnvironment = Object.fromEntries(
  ENVIRONMENT_NAMES.map((name) => [name, process.env[name]])
) as Record<(typeof ENVIRONMENT_NAMES)[number], string | undefined>;

afterEach(() => {
  for (const name of ENVIRONMENT_NAMES) {
    const original = originalEnvironment[name];
    if (original === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = original;
    }
  }
  jest.resetModules();
});

describe('public provider Railway identity config wiring', () => {
  it('enables real-IP trust only for exact opt-in with the complete service tuple', async () => {
    process.env.PUBLIC_PROVIDER_TRUST_RAILWAY_REAL_IP = 'true';
    process.env.RAILWAY_PROJECT_ID = 'project';
    process.env.RAILWAY_ENVIRONMENT_ID = 'environment';
    process.env.RAILWAY_SERVICE_ID = '';
    jest.resetModules();

    const incompleteConfig = (await import('../src/platform/runtime/config.js')).config;
    expect(incompleteConfig.limits.publicProviderTrustRailwayRealIp).toBe(false);

    process.env.RAILWAY_SERVICE_ID = 'service';
    jest.resetModules();
    const completeConfig = (await import('../src/platform/runtime/config.js')).config;
    expect(completeConfig.limits.publicProviderTrustRailwayRealIp).toBe(true);
  });
});
