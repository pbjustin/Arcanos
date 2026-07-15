import { describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const jestBinaryPath = path.join(projectRoot, 'node_modules', 'jest', 'bin', 'jest.js');
const jestConfigPath = path.join(projectRoot, 'jest.config.js');
const isolatedKeys = [
  'DATABASE_PRIVATE_URL',
  'DATABASE_PUBLIC_URL',
  'DATABASE_URL',
  'PGDATABASE',
  'PGHOST',
  'PGPASSWORD',
  'PGPORT',
  'PGUSER',
  'POSTGRES_DATABASE',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PASSWORD',
  'POSTGRES_PORT',
  'POSTGRES_PRISMA_URL',
  'POSTGRES_URL',
  'POSTGRES_USER',
  'SESSION_PERSISTENCE_CLIENT',
  'SESSION_PERSISTENCE_SQLITE_PATH',
  'SESSION_PERSISTENCE_URL',
];

describe('test environment isolation', () => {
  it('keeps database and session persistence disabled across repeated dotenv loads', () => {
    const tempDirectory = mkdtempSync(
      path.join(projectRoot, 'tests', '.test-env-isolation-')
    );
    const syntheticValues = Object.fromEntries(
      isolatedKeys.map((key, index) => [key, `synthetic-non-network-value-${index}`])
    );
    syntheticValues.SESSION_PERSISTENCE_CLIENT = 'better-sqlite3';
    syntheticValues.SESSION_PERSISTENCE_SQLITE_PATH = './synthetic-session-cache.sqlite';
    const syntheticEnv = isolatedKeys.map((key) => `${key}=${syntheticValues[key]}`).join('\n');
    const probePath = path.join(tempDirectory, 'probe.test.ts');
    const probeSource = `
      import { expect, jest, test } from '@jest/globals';
      import dotenv from 'dotenv';

      const poolSpy = jest.fn();
      const knexFactorySpy = jest.fn();

      jest.unstable_mockModule('pg', () => ({
        default: { Pool: poolSpy },
        Pool: poolSpy,
      }));
      jest.unstable_mockModule('knex', () => ({ default: knexFactorySpy }));

      const isolatedKeys = ${JSON.stringify(isolatedKeys)};
      const expectIsolationSentinels = () => {
        expect(Object.fromEntries(isolatedKeys.map((key) => [key, process.env[key]]))).toEqual(
          Object.fromEntries(isolatedKeys.map((key) => [key, '']))
        );
      };

      test('preserves offline sentinels through application initialization', async () => {
        await import('../../scripts/test-env.mjs');

        dotenv.config();
        expectIsolationSentinels();

        const database = await import('../../src/core/db/client.js');
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const initialized = await database.initializeDatabase();
        errorSpy.mockRestore();

        expect(initialized).toBe(false);
        expect(database.getPool()).toBeNull();
        expect(poolSpy).not.toHaveBeenCalled();
        expectIsolationSentinels();

        dotenv.config();
        expectIsolationSentinels();
        expect(database.resolveDatabaseConnectionCandidates(process.env)).toEqual([]);

        const sessionPersistence = await import('../../src/core/memory/sessionPersistence.js');
        expect(sessionPersistence.createSessionPersistenceAdapter()).toBeNull();
        expect(knexFactorySpy).not.toHaveBeenCalled();
        expectIsolationSentinels();
      });
    `;

    try {
      writeFileSync(path.join(tempDirectory, '.env'), `${syntheticEnv}\n`, 'utf8');
      writeFileSync(probePath, probeSource, 'utf8');

      const completed = spawnSync(
        process.execPath,
        [
          '--disable-warning=ExperimentalWarning',
          '--experimental-vm-modules',
          jestBinaryPath,
          '--config',
          jestConfigPath,
          '--roots',
          tempDirectory,
          '--runTestsByPath',
          probePath,
          '--runInBand',
          '--coverage=false',
        ],
        {
          cwd: tempDirectory,
          encoding: 'utf8',
          env: { NODE_ENV: 'test' },
        }
      );

      expect({
        status: completed.status,
        stdout: completed.stdout,
        stderr: completed.stderr,
      }).toEqual(expect.objectContaining({ status: 0 }));
    } finally {
      rmSync(tempDirectory, { recursive: true, force: true });
    }
  });
});
