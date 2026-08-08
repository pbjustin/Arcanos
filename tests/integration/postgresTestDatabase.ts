export const POSTGRES_TESTS_REQUIRE_DATABASE_ENV =
  'ARCANOS_POSTGRES_TESTS_REQUIRE_DATABASE';
export const POSTGRES_TEST_DATABASE_NAME = 'arcanos_audit_pg18_20260727';

type TestEnvironment = Readonly<Record<string, string | undefined>>;

function decodeRequiredComponent(
  value: string,
  component: string,
  databaseEnvironment: string
): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(
      `${databaseEnvironment} contains an invalid encoded ${component}.`
    );
  }

  if (!decoded || /[\u0000-\u001f\u007f]/u.test(decoded)) {
    throw new Error(
      `${databaseEnvironment} must include a non-empty ${component} without control characters.`
    );
  }
  return decoded;
}

/** Resolve one dedicated test URL under the shared required-PostgreSQL mode. */
export function resolvePostgresTestDatabaseUrl(
  databaseEnvironment: string,
  environment: TestEnvironment = process.env
): string {
  const requiredValue =
    environment[POSTGRES_TESTS_REQUIRE_DATABASE_ENV]?.trim() ?? '';
  if (requiredValue && requiredValue !== '1') {
    throw new Error(
      `${POSTGRES_TESTS_REQUIRE_DATABASE_ENV} must be 1 when set.`
    );
  }

  const connectionString = environment[databaseEnvironment]?.trim() ?? '';
  if (requiredValue === '1' && !connectionString) {
    throw new Error(
      `${databaseEnvironment} is required when ${POSTGRES_TESTS_REQUIRE_DATABASE_ENV}=1.`
    );
  }
  return connectionString;
}

/** Guard a configured test URL before a suite can create or drop database state. */
export function assertDisposablePostgresTestDatabaseUrl(
  value: string,
  databaseEnvironment: string
): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${databaseEnvironment} must be a valid PostgreSQL URL.`);
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(
      `${databaseEnvironment} must use postgres:// or postgresql://.`
    );
  }
  if (parsed.search || parsed.hash) {
    throw new Error(
      `${databaseEnvironment} must not include query parameters or a fragment.`
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (!new Set(['localhost', '127.0.0.1', '::1', '[::1]']).has(host)) {
    throw new Error(`${databaseEnvironment} must target a loopback host.`);
  }
  if (!parsed.port || !/^\d+$/u.test(parsed.port)) {
    throw new Error(
      `${databaseEnvironment} must include an explicit numeric port.`
    );
  }
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${databaseEnvironment} must include a valid TCP port.`);
  }

  let databasePath: string;
  try {
    databasePath = decodeURIComponent(parsed.pathname);
  } catch {
    throw new Error(
      `${databaseEnvironment} contains an invalid encoded database.`
    );
  }
  if (databasePath !== `/${POSTGRES_TEST_DATABASE_NAME}`) {
    throw new Error(
      `${databaseEnvironment} must target disposable database ${POSTGRES_TEST_DATABASE_NAME}.`
    );
  }

  decodeRequiredComponent(parsed.username, 'username', databaseEnvironment);
  decodeRequiredComponent(parsed.password, 'password', databaseEnvironment);
}
