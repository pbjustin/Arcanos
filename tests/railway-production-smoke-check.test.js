import { describe, expect, it, jest } from '@jest/globals';
import {
  RESULT_STATUS,
  evaluateAppLogEntries,
  evaluateDatabaseLogEntries,
  evaluateRedisLogEntries,
  evaluateRuntimeWiring,
  extractEnvironmentSnapshot,
  findRoleServices,
  parseArgs,
  parseJsonLines,
  resolveHealthUrl,
  runSmokeCheck,
  requestHealthCheck
} from '../scripts/railway-production-smoke-check.js';

function buildSmokeConfig(overrides = {}) {
  return {
    environment: 'production',
    appService: 'ARCANOS V2',
    workerService: 'ARCANOS Worker',
    databaseService: '',
    redisService: '',
    appUrl: '',
    healthPath: '/readyz',
    appLogLines: 300,
    workerLogLines: 300,
    databaseLogLines: 500,
    redisLogLines: 200,
    requestTimeoutMs: 15000,
    ...overrides
  };
}

function productionReadinessPayload(checks = [
  { name: 'openai', healthy: true, duration: 1 },
  { name: 'database', healthy: true, duration: 1 },
  { name: 'redis', healthy: true, duration: 1 },
  { name: 'startup', healthy: true, duration: 1 }
]) {
  return {
    ready: true,
    status: 'healthy',
    timestamp: '2026-03-22T23:39:41.407Z',
    duration: 4,
    checks
  };
}

function readinessFetchResponse(body, {
  status = 200,
  headers = {},
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      ...headers,
    }),
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

describe('railway-production-smoke-check', () => {
  it('uses the role-aware readiness path and cannot be downgraded to liveness', () => {
    expect(parseArgs([]).healthPath).toBe('/readyz');
    expect(parseArgs(['--health-path', '/health']).healthPath).toBe('/readyz');
    expect(parseArgs(['--health-path', '/readyz']).healthPath).toBe('/readyz');
  });

  it('fails closed before Railway access when an exact public app origin is omitted', async () => {
    await expect(runSmokeCheck(buildSmokeConfig())).resolves.toEqual([
      {
        name: 'Smoke-check target',
        status: RESULT_STATUS.FAIL,
        detail: 'An explicit confirmed --app-url HTTPS root origin is required.',
      },
    ]);
  });

  it('builds readiness URLs only from credential-free HTTPS root origins', () => {
    const service = {
      customDomains: [],
      serviceDomains: ['arcanos-production.up.railway.app']
    };

    expect(resolveHealthUrl({}, service, buildSmokeConfig())).toBe(
      'https://arcanos-production.up.railway.app/readyz'
    );
    expect(resolveHealthUrl({}, service, buildSmokeConfig({
      appUrl: 'https://ARCANOS-PRODUCTION.UP.RAILWAY.APP/'
    }))).toBe('https://arcanos-production.up.railway.app/readyz');
    expect(() => resolveHealthUrl({}, service, buildSmokeConfig({
      appUrl: 'https://example.com/'
    }))).toThrow(/selected Railway app service/i);

    for (const appUrl of [
      'http://example.com',
      'https://operator:secret@example.com',
      'https://example.com/health',
      'https://example.com?next=ready',
      'https://example.com#ready'
    ]) {
      expect(() => resolveHealthUrl({}, service, buildSmokeConfig({ appUrl }))).toThrow(
        /HTTPS root origin/i
      );
    }
  });

  it('extracts the production topology and resolves all four service roles', () => {
    const snapshot = extractEnvironmentSnapshot(
      {
        name: 'Arcanos',
        workspace: { name: "pbjustin's Projects" },
        services: {
          edges: [
            { node: { id: 'app', name: 'ARCANOS V2' } },
            { node: { id: 'worker', name: 'ARCANOS Worker' } },
            { node: { id: 'db', name: 'Postgres-BTrN' } },
            { node: { id: 'redis', name: 'Redis-lQbV' } }
          ]
        },
        environments: {
          edges: [
            {
              node: {
                name: 'production',
                serviceInstances: {
                  edges: [
                    {
                      node: {
                        serviceId: 'app',
                        serviceName: 'ARCANOS V2',
                        latestDeployment: { status: 'SUCCESS', createdAt: '2026-03-08T04:12:59.062Z' },
                        activeDeployments: [{ status: 'SUCCESS' }],
                        domains: {
                          serviceDomains: [{ domain: 'acranos-production.up.railway.app' }],
                          customDomains: []
                        }
                      }
                    },
                    {
                      node: {
                        serviceId: 'worker',
                        serviceName: 'ARCANOS Worker',
                        latestDeployment: { status: 'SUCCESS', createdAt: '2026-03-08T02:37:35.855Z' },
                        activeDeployments: [{ status: 'SUCCESS' }],
                        domains: {
                          serviceDomains: [],
                          customDomains: []
                        }
                      }
                    },
                    {
                      node: {
                        serviceId: 'db',
                        serviceName: 'Postgres-BTrN',
                        latestDeployment: { status: 'SUCCESS', createdAt: '2026-02-03T07:30:06.462Z' },
                        activeDeployments: [{ status: 'SUCCESS' }],
                        domains: {
                          serviceDomains: [],
                          customDomains: []
                        }
                      }
                    },
                    {
                      node: {
                        serviceId: 'redis',
                        serviceName: 'Redis-lQbV',
                        latestDeployment: { status: 'SUCCESS', createdAt: '2026-02-24T06:38:37.033Z' },
                        activeDeployments: [{ status: 'SUCCESS' }],
                        domains: {
                          serviceDomains: [],
                          customDomains: []
                        }
                      }
                    }
                  ]
                }
              }
            }
          ]
        }
      },
      'production'
    );

    const roles = findRoleServices(snapshot.serviceInstances, {
      environment: 'production',
      appService: 'ARCANOS V2',
      workerService: 'ARCANOS Worker',
      databaseService: '',
      redisService: '',
      appUrl: '',
      healthPath: '/readyz',
      appLogLines: 300,
      workerLogLines: 300,
      databaseLogLines: 500,
      redisLogLines: 200,
      requestTimeoutMs: 15000
    });

    expect(snapshot.projectName).toBe('Arcanos');
    expect(roles.app.name).toBe('ARCANOS V2');
    expect(roles.worker.name).toBe('ARCANOS Worker');
    expect(roles.database.name).toBe('Postgres-BTrN');
    expect(roles.redis.name).toBe('Redis-lQbV');
  });

  it('passes runtime wiring when app and worker share production Postgres and Redis settings', () => {
    const results = evaluateRuntimeWiring(
      {
        NODE_ENV: 'production',
        PGHOST: 'postgres-btrn.railway.internal',
        PGPORT: '5432',
        PGDATABASE: 'railway',
        PGUSER: 'postgres',
        REDISHOST: 'redis-lqbv.railway.internal',
        REDISPORT: '6379',
        DATABASE_URL: 'postgres://masked',
        REDIS_URL: 'redis://masked'
      },
      {
        NODE_ENV: 'production',
        PGHOST: 'postgres-btrn.railway.internal',
        PGPORT: '5432',
        PGDATABASE: 'railway',
        PGUSER: 'postgres',
        REDISHOST: 'redis-lqbv.railway.internal',
        REDISPORT: '6379',
        DATABASE_URL: 'postgres://masked',
        REDIS_URL: 'redis://masked'
      },
      'production'
    );

    expect(results.every((result) => result.status !== RESULT_STATUS.FAIL)).toBe(true);
    expect(results.find((result) => result.name === 'Shared backend wiring')?.status).toBe(RESULT_STATUS.PASS);
  });

  it('accepts production NODE_ENV when checking a Railway preview environment', () => {
    const results = evaluateRuntimeWiring(
      {
        NODE_ENV: 'production',
        PGHOST: 'postgres-btrn.railway.internal',
        PGPORT: '5432',
        PGDATABASE: 'railway',
        PGUSER: 'postgres',
        REDISHOST: 'redis-lqbv.railway.internal',
        REDISPORT: '6379',
        DATABASE_URL: 'postgres://masked',
        REDIS_URL: 'redis://masked'
      },
      {
        NODE_ENV: 'production',
        PGHOST: 'postgres-btrn.railway.internal',
        PGPORT: '5432',
        PGDATABASE: 'railway',
        PGUSER: 'postgres',
        REDISHOST: 'redis-lqbv.railway.internal',
        REDISPORT: '6379',
        DATABASE_URL: 'postgres://masked',
        REDIS_URL: 'redis://masked'
      },
      'Arcanos-pr-1227'
    );

    expect(results.find((result) => result.name === 'Runtime environment identity')?.status).toBe(RESULT_STATUS.PASS);
    expect(results.every((result) => result.status !== RESULT_STATUS.FAIL)).toBe(true);
  });

  it('accepts the passive readiness payload during preview checks', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => readinessFetchResponse({
        ready: true,
        mode: 'passive-pr-preview',
        processKind: 'web'
      }));

    try {
      const result = await requestHealthCheck(
        'https://arcanos-v2-arcanos-pr-1227.up.railway.app/readyz',
        {
          environment: 'Arcanos-pr-1227',
          appService: 'ARCANOS V2',
          workerService: 'ARCANOS Worker',
          databaseService: '',
          redisService: '',
          appUrl: '',
          healthPath: '/readyz',
          appLogLines: 300,
          workerLogLines: 300,
          databaseLogLines: 500,
          redisLogLines: 200,
          requestTimeoutMs: 15000
        },
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.PASS);
      expect(result.detail).toMatch(/passive-pr-preview/);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('accepts only the production readiness payload shape', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => readinessFetchResponse(
      productionReadinessPayload(),
    ));

    try {
      const result = await requestHealthCheck(
        'https://acranos-production.up.railway.app/readyz',
        {
          environment: 'production',
          appService: 'ARCANOS V2',
          workerService: 'ARCANOS Worker',
          databaseService: '',
          redisService: '',
          appUrl: '',
          healthPath: '/readyz',
          appLogLines: 300,
          workerLogLines: 300,
          databaseLogLines: 500,
          redisLogLines: 200,
          requestTimeoutMs: 15000
        },
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.PASS);
      expect(result.detail).toMatch(/ready=true/i);
      expect(result.detail).toMatch(/status=healthy/i);
      expect(global.fetch).toHaveBeenCalledWith(
        'https://acranos-production.up.railway.app/readyz',
        expect.objectContaining({ redirect: 'error' })
      );
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([
    ['content-type', 'not-application/json-garbage'],
    ['cache-control', 'private="no-store-false"'],
  ])('rejects a lookalike %s readiness header', async (headerName, headerValue) => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => readinessFetchResponse(
      productionReadinessPayload(),
      { headers: { [headerName]: headerValue } },
    ));

    try {
      const result = await requestHealthCheck(
        'https://acranos-production.up.railway.app/readyz',
        buildSmokeConfig(),
        'production',
      );

      expect(result.status).toBe(RESULT_STATUS.FAIL);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('requires exact HTTP 200 and does not reflect the target or body on failure', async () => {
    const originalFetch = global.fetch;
    const sensitiveUrl = 'https://acranos-production.up.railway.app/readyz';
    const sensitiveBody = 'do-not-reflect-response-body';
    global.fetch = jest.fn(async () => readinessFetchResponse({
        ...productionReadinessPayload(),
        diagnostic: sensitiveBody
      }, { status: 204 }));

    try {
      const result = await requestHealthCheck(
        sensitiveUrl,
        buildSmokeConfig(),
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.FAIL);
      expect(result.detail).toContain('status=204');
      expect(result.detail).not.toContain(sensitiveUrl);
      expect(result.detail).not.toContain(sensitiveBody);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it.each([
    {
      label: 'unknown check',
      checks: [{ name: 'lookalike', healthy: true }]
    },
    {
      label: 'duplicate check',
      checks: [
        { name: 'openai', healthy: true },
        { name: 'database', healthy: true },
        { name: 'redis', healthy: true },
        { name: 'redis', healthy: true }
      ]
    },
    {
      label: 'extra check',
      checks: [
        { name: 'openai', healthy: true },
        { name: 'database', healthy: true },
        { name: 'redis', healthy: true },
        { name: 'startup', healthy: true },
        { name: 'other', healthy: true }
      ]
    }
  ])('rejects a production readiness payload with $label names', async ({ checks }) => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => readinessFetchResponse(
      productionReadinessPayload(checks),
    ));

    try {
      const result = await requestHealthCheck(
        'https://acranos-production.up.railway.app/readyz',
        buildSmokeConfig(),
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.FAIL);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps preview and production readiness contracts mutually exclusive', async () => {
    const originalFetch = global.fetch;

    try {
      global.fetch = jest.fn(async () => readinessFetchResponse(
        productionReadinessPayload(),
      ));
      const previewWithProductionShape = await requestHealthCheck(
        'https://arcanos-v2-arcanos-pr-1227.up.railway.app/readyz',
        buildSmokeConfig({ environment: 'Arcanos-pr-1227' }),
        'production'
      );

      global.fetch = jest.fn(async () => readinessFetchResponse({
          ready: true,
          mode: 'passive-pr-preview',
          processKind: 'web'
        }));
      const productionWithPreviewShape = await requestHealthCheck(
        'https://acranos-production.up.railway.app/readyz',
        buildSmokeConfig(),
        'production'
      );

      expect(previewWithProductionShape.status).toBe(RESULT_STATUS.FAIL);
      expect(productionWithPreviewShape.status).toBe(RESULT_STATUS.FAIL);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails closed when the readiness response exceeds the bounded body budget', async () => {
    const originalFetch = global.fetch;
    const sensitiveUrl = 'https://acranos-production.up.railway.app/readyz';
    const oversizedBody = `oversized-secret-${'x'.repeat(70 * 1024)}`;
    global.fetch = jest.fn(async () => new Response(oversizedBody, {
      status: 200,
      headers: { 'content-type': 'application/json' }
    }));

    try {
      const result = await requestHealthCheck(
        sensitiveUrl,
        buildSmokeConfig(),
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.FAIL);
      expect(result.detail).toMatch(/response.*limit/i);
      expect(result.detail).not.toContain(sensitiveUrl);
      expect(result.detail).not.toContain('oversized-secret');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('rejects a liveness payload as production readiness evidence', async () => {
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => readinessFetchResponse({
        status: 'ok',
        service: 'arcanos-backend',
        version: '1.0.0',
        gpt_routes: 23,
        openai_configured: true
      }));

    try {
      const result = await requestHealthCheck(
        'https://acranos-production.up.railway.app/readyz',
        {
          environment: 'production',
          appService: 'ARCANOS V2',
          workerService: 'ARCANOS Worker',
          databaseService: '',
          redisService: '',
          appUrl: '',
          healthPath: '/readyz',
          appLogLines: 300,
          workerLogLines: 300,
          databaseLogLines: 500,
          redisLogLines: 200,
          requestTimeoutMs: 15000
        },
        'production'
      );

      expect(result.status).toBe(RESULT_STATUS.FAIL);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('fails database log evaluation when the missing User table error appears', () => {
    const result = evaluateDatabaseLogEntries(
      parseJsonLines([
        JSON.stringify({ level: 'error', message: '2026-03-06 02:42:01.855 UTC [25385] ERROR:  relation "User" does not exist' }),
        JSON.stringify({ level: 'error', message: '2026-03-08 02:42:11.892 UTC [28] LOG:  checkpoint complete: wrote 36 buffers' })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.FAIL);
    expect(result.detail).toMatch(/relation "User" does not exist/i);
  });

  it('passes when Railway Redis reports readiness alongside the standard overcommit advisory', () => {
    const result = evaluateRedisLogEntries(
      parseJsonLines([
        JSON.stringify({ level: 'info', message: '1:C 24 Feb 2026 06:38:47.711 # WARNING Memory overcommit must be enabled!' }),
        JSON.stringify({ level: 'info', message: '1:M 24 Feb 2026 06:38:47.721 * Ready to accept connections tcp' })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.PASS);
    expect(result.detail).toMatch(/ready-to-accept-connections/i);
    expect(result.detail).toMatch(/vm\.overcommit_memory/i);
  });

  it('ignores the benign Node JSON ExperimentalWarning when healthy traffic is present', () => {
    const result = evaluateAppLogEntries(
      parseJsonLines([
        JSON.stringify({
          level: 'error',
          message: '(node:13) ExperimentalWarning: Importing JSON modules is an experimental feature and might change at any time'
        }),
        JSON.stringify({
          level: 'error',
          message: '(Use `node --trace-warnings ...` to show where the warning was created)'
        }),
        JSON.stringify({
          level: 'info',
          event: 'request.completed',
          path: '/readyz',
          data: { statusCode: 200 },
          message: 'request completed'
        })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.PASS);
    expect(result.detail).toMatch(/healthy diagnostics/i);
  });

  it('passes when only the Redis overcommit advisory is present without a readiness marker', () => {
    const result = evaluateRedisLogEntries(
      parseJsonLines([
        JSON.stringify({ level: 'info', message: '1:C 24 Feb 2026 06:38:47.711 # WARNING Memory overcommit must be enabled!' })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.PASS);
    expect(result.detail).toMatch(/vm\.overcommit_memory/i);
  });

  it('passes when Redis logs are readable and quiet but contain no fatal markers', () => {
    const result = evaluateRedisLogEntries(
      parseJsonLines([
        JSON.stringify({ level: 'info', message: '1:M 24 Feb 2026 06:38:47.711 * Background append only file rewriting started by pid 42' })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.PASS);
    expect(result.detail).toMatch(/free of fatal markers/i);
  });
});
