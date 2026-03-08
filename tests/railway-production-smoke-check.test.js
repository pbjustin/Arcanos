import { describe, expect, it } from '@jest/globals';
import {
  RESULT_STATUS,
  evaluateDatabaseLogEntries,
  evaluateRedisLogEntries,
  evaluateRuntimeWiring,
  extractEnvironmentSnapshot,
  findRoleServices,
  parseJsonLines
} from '../scripts/railway-production-smoke-check.js';

describe('railway-production-smoke-check', () => {
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
      healthPath: '/healthz',
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

  it('warns for the standard Redis overcommit advisory while preserving the readiness signal', () => {
    const result = evaluateRedisLogEntries(
      parseJsonLines([
        JSON.stringify({ level: 'info', message: '1:C 24 Feb 2026 06:38:47.711 # WARNING Memory overcommit must be enabled!' }),
        JSON.stringify({ level: 'info', message: '1:M 24 Feb 2026 06:38:47.721 * Ready to accept connections tcp' })
      ].join('\n'))
    );

    expect(result.status).toBe(RESULT_STATUS.WARN);
    expect(result.detail).toMatch(/ready-to-accept-connections/i);
  });
});
