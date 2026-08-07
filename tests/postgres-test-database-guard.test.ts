import { describe, expect, it } from '@jest/globals';
import {
  assertDisposablePostgresTestDatabaseUrl,
  POSTGRES_TESTS_REQUIRE_DATABASE_ENV,
  resolvePostgresTestDatabaseUrl,
} from './integration/postgresTestDatabase.js';

const TEST_DATABASE_ENV = 'EXAMPLE_POSTGRES_TEST_DATABASE_URL';
const DISPOSABLE_URL =
  'postgresql://audit-user:audit-password@127.0.0.1:55432/arcanos_audit_pg18_20260727';

describe('shared PostgreSQL test database guard', () => {
  it('keeps missing database configuration optional when required mode is absent', () => {
    expect(resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV, {})).toBe('');
  });

  it('returns a trimmed dedicated URL without reading ambient DATABASE_URL', () => {
    expect(resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV, {
      DATABASE_URL: 'postgresql://ambient.invalid/production',
      [TEST_DATABASE_ENV]: `  ${DISPOSABLE_URL}  `,
    })).toBe(DISPOSABLE_URL);
  });

  it('fails when required mode is active and the dedicated URL is absent', () => {
    expect(() => resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV, {
      DATABASE_URL: DISPOSABLE_URL,
      [POSTGRES_TESTS_REQUIRE_DATABASE_ENV]: '1',
    })).toThrow(
      `${TEST_DATABASE_ENV} is required when ${POSTGRES_TESTS_REQUIRE_DATABASE_ENV}=1.`
    );
  });

  it('rejects a nonempty sentinel value other than one', () => {
    expect(() => resolvePostgresTestDatabaseUrl(TEST_DATABASE_ENV, {
      [POSTGRES_TESTS_REQUIRE_DATABASE_ENV]: 'true',
    })).toThrow(`${POSTGRES_TESTS_REQUIRE_DATABASE_ENV} must be 1 when set.`);
  });

  it('accepts only the exact credentialed loopback disposable target', () => {
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      DISPOSABLE_URL,
      TEST_DATABASE_ENV
    )).not.toThrow();

    expect(() => assertDisposablePostgresTestDatabaseUrl(
      'postgresql://audit-user:audit-password@db.example.test:5432/arcanos_audit_pg18_20260727',
      TEST_DATABASE_ENV
    )).toThrow(`${TEST_DATABASE_ENV} must target a loopback host.`);
    expect(() => assertDisposablePostgresTestDatabaseUrl(
      'postgresql://audit-user:audit-password@127.0.0.1:5432/arcanos',
      TEST_DATABASE_ENV
    )).toThrow(
      `${TEST_DATABASE_ENV} must target disposable database arcanos_audit_pg18_20260727.`
    );
  });
});
