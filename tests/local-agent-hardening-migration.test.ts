import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from '@jest/globals';

import {
  MIGRATION_DATABASE_ENV,
  LocalAgentHardeningMigrationError,
  parseArgs,
  readMigrationConnectionConfig,
  readMigrationConnectionString,
  validateMigrationArtifacts,
  validatePreviewTarget
} from '../scripts/local-agent-hardening-migration.mjs';

describe('local-agent job hardening migration guard', () => {
  test('pins the reviewed additive migration and compensation artifacts', () => {
    expect(validateMigrationArtifacts()).toMatchObject({
      ok: true,
      version: '20260724_local_agent_job_hardening_v1',
      checksum: '75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed',
      calculatedChecksum:
        '75cf9f3a914fafbd8d1ad453a2f47c5f930e8f2bdf45ac6e61f672c74f775bed',
      issues: []
    });

    const migrationSql = readFileSync(
      join(
        process.cwd(),
        'migrations',
        '20260724_local_agent_job_hardening_v1',
        '01_local_agent_job_idempotency.sql'
      ),
      'utf8'
    );
    expect(migrationSql).not.toContain("status <> 'expired'");

    const startupSchema = readFileSync(
      join(process.cwd(), 'src', 'core', 'db', 'schema.ts'),
      'utf8'
    );
    expect(startupSchema).not.toContain(
      'CREATE TABLE IF NOT EXISTS local_agent_job_idempotency'
    );
  });

  test('requires exact preview identities and rejects the Phase 2E target', () => {
    const options = parseArgs([
      '--verify-preview',
      '--confirm-preview',
      '--expected-project-id',
      'project-preview',
      '--expected-environment-id',
      'environment-preview',
      '--expected-postgres-service-id',
      'service-postgres-preview'
    ]);

    expect(
      validatePreviewTarget(options, {
        RAILWAY_PROJECT_ID: 'project-preview',
        RAILWAY_ENVIRONMENT_ID: 'environment-preview',
        RAILWAY_ENVIRONMENT_NAME: 'arcanos-local-agent-preview-abc123',
        RAILWAY_SERVICE_ID: 'service-postgres-preview',
        RAILWAY_SERVICE_NAME: 'Postgres Preview',
        LOCAL_AGENT_HARDENING_PREVIEW_TARGET: 'true'
      })
    ).toMatchObject({
      projectId: 'project-preview',
      environmentId: 'environment-preview',
      postgresServiceId: 'service-postgres-preview'
    });

    expect(() =>
      validatePreviewTarget(options, {
        RAILWAY_PROJECT_ID: 'project-preview',
        RAILWAY_ENVIRONMENT_ID: 'environment-preview',
        RAILWAY_ENVIRONMENT_NAME: 'phase2e-validation-20260717',
        RAILWAY_SERVICE_ID: 'service-postgres-preview',
        RAILWAY_SERVICE_NAME: 'Postgres Preview',
        LOCAL_AGENT_HARDENING_PREVIEW_TARGET: 'true'
      })
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_AGENT_MIGRATION_FORBIDDEN_TARGET'
      })
    );
  });

  test('uses only the Railway-bound public URL for the validated Postgres service', () => {
    expect(MIGRATION_DATABASE_ENV).toBe('DATABASE_PUBLIC_URL');
    expect(() =>
      readMigrationConnectionString({
        DATABASE_URL: 'postgresql://production.invalid/arcanos'
      })
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_AGENT_MIGRATION_DATABASE_TARGET_UNBOUND'
      })
    );

    const target = {
      projectId: 'project-preview',
      environmentId: 'environment-preview',
      postgresServiceId: 'service-postgres-preview'
    };
    const railwayEnvironment = {
      RAILWAY_PROJECT_ID: target.projectId,
      RAILWAY_ENVIRONMENT_ID: target.environmentId,
      RAILWAY_SERVICE_ID: target.postgresServiceId,
      DATABASE_PUBLIC_URL:
        'postgresql://preview-user:preview-test-password@public-proxy.example:5432/preview-db',
      DATABASE_URL:
        'postgresql://preview-user:preview-test-password@postgres.railway.internal:5432/preview-db',
      PGUSER: 'preview-user',
      PGPASSWORD: 'preview-test-password',
      PGDATABASE: 'preview-db',
      PGHOST: 'postgres.railway.internal',
      PGPORT: '5432',
      RAILWAY_TCP_PROXY_DOMAIN: 'public-proxy.example',
      RAILWAY_TCP_PROXY_PORT: '5432'
    };

    expect(readMigrationConnectionString(railwayEnvironment, target)).toBe(
      railwayEnvironment.DATABASE_PUBLIC_URL
    );
    expect(readMigrationConnectionConfig(railwayEnvironment, target)).toEqual({
      host: 'public-proxy.example',
      port: 5432,
      user: 'preview-user',
      'password': 'preview-test-password',
      database: 'preview-db'
    });
    expect(() =>
      readMigrationConnectionString(
        {
          ...railwayEnvironment,
          DATABASE_PUBLIC_URL:
            'postgresql://other-user:other-password@other.example:5432/other-db'
        },
        target
      )
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_AGENT_MIGRATION_DATABASE_SERVICE_BINDING_INVALID'
      })
    );
    expect(() =>
      readMigrationConnectionString(
        {
          ...railwayEnvironment,
          DATABASE_PUBLIC_URL:
            'postgresql://preview-user:preview-test-password@foreign.proxy.rlwy.net:5432/preview-db'
        },
        target
      )
    ).toThrow(
      expect.objectContaining({
        code: 'LOCAL_AGENT_MIGRATION_DATABASE_SERVICE_BINDING_INVALID'
      })
    );
    for (const query of [
      'host=foreign.proxy.rlwy.net',
      'port=6543',
      'user=other-user',
      'password=other-test-password',
      'sslcert=outside.crt',
      'sslkey=outside.key',
      'sslrootcert=outside-ca.crt'
    ]) {
      expect(() =>
        readMigrationConnectionConfig(
          {
            ...railwayEnvironment,
            DATABASE_PUBLIC_URL:
              `${railwayEnvironment.DATABASE_PUBLIC_URL}?${query}`
          },
          target
        )
      ).toThrow(
        expect.objectContaining({
          code: 'LOCAL_AGENT_MIGRATION_DATABASE_URL_PARAMETERS_DENIED'
        })
      );
    }
    expect(
      readMigrationConnectionConfig(
        {
          ...railwayEnvironment,
          DATABASE_PUBLIC_URL:
            `${railwayEnvironment.DATABASE_PUBLIC_URL}?sslmode=no-verify`
        },
        target
      )
    ).toEqual({
      host: 'public-proxy.example',
      port: 5432,
      user: 'preview-user',
      'password': 'preview-test-password',
      database: 'preview-db',
      ssl: { rejectUnauthorized: false }
    });
  });

  test('requires an explicit preview confirmation before target validation', () => {
    const options = parseArgs([
      '--apply-preview',
      '--expected-project-id',
      'project-preview',
      '--expected-environment-id',
      'environment-preview',
      '--expected-postgres-service-id',
      'service-postgres-preview'
    ]);

    expect(() =>
      validatePreviewTarget(options, {})
    ).toThrow(LocalAgentHardeningMigrationError);
  });
});
