import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, 'scripts', 'phase2e-migration-validator.mjs');
const pg18RunnerPath = join(repositoryRoot, 'scripts', 'phase2e-pg18-runner.mjs');
const dockerfilePath = join(repositoryRoot, 'Dockerfile.phase2e-validator');
const pg18DockerfilePath = join(repositoryRoot, 'Dockerfile.phase2e-postgres18-integration');
const railwayConfigPath = join(repositoryRoot, 'railway.phase2e-validator.json');
const entrypointPath = join(repositoryRoot, 'scripts', 'phase2e-validator-entrypoint.sh');
const operationConfigPaths = [
  ['plan', railwayConfigPath],
  ['apply', join(repositoryRoot, 'railway.phase2e-validator.apply.json')],
  ['verify', join(repositoryRoot, 'railway.phase2e-validator.verify.json')],
  ['verify-runtime', join(repositoryRoot, 'railway.phase2e-validator.runtime-verify.json')],
  ['drain', join(repositoryRoot, 'railway.phase2e-validator.drain.json')],
] as const;
const pg18RailwayConfigPath = join(
  repositoryRoot,
  'railway.phase2e-validator.pg18-integration.json',
);
const credentialSentinel = 'PHASE2E_VALIDATOR_CREDENTIAL_SENTINEL';

interface ValidatorModule {
  PHASE2E_VALIDATOR_ENVIRONMENT_ID: string;
  PHASE2E_VALIDATOR_ENVIRONMENT_NAME: string;
  PHASE2E_VALIDATOR_PROJECT_ID: string;
  parseValidatorOperation: (argv: string[]) =>
    'plan' | 'apply' | 'verify' | 'verify-runtime' | 'drain';
  safeOperationResult: (
    context: Record<string, string>,
    operation: 'drain',
    migration: Record<string, string | number>,
    result: Record<string, unknown>
  ) => { ok: boolean; code: string };
  safeFailureCode: (error: unknown) => string;
  validatePrivateDatabaseUrl: (value: unknown) => string;
  validateDatabaseIdentityRows: (rows: unknown, expectedDatabaseName: string) => void;
  validateValidatorEnvironment: (environment: Record<string, string>) => {
    databaseUrl: string;
    environmentId: string;
    projectId: string;
    serviceId: string;
  };
}

let validator: ValidatorModule;

function validEnvironment(): Record<string, string> {
  const serviceId = '12345678-1234-4123-8123-123456789abc';
  const serviceName = 'phase2e-postgres18-validator-contract';
  return {
    DATABASE_URL:
      `postgresql://validator:${credentialSentinel}@phase2e-postgres-replacement.railway.internal:5432/railway`,
    PHASE2E_VALIDATOR_EXPECTED_DATABASE_HOST:
      'phase2e-postgres-replacement.railway.internal',
    PHASE2E_VALIDATOR_EXPECTED_DATABASE_NAME: 'railway',
    PHASE2E_VALIDATOR_EXPECTED_SERVICE_ID: serviceId,
    PHASE2E_VALIDATOR_EXPECTED_SERVICE_NAME: serviceName,
    PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT: 'a'.repeat(40),
    RAILWAY_ENVIRONMENT_ID: 'fb99f47d-5ef5-44c1-96c2-acf7b90fab13',
    RAILWAY_ENVIRONMENT_NAME: 'phase2e-validation-20260717',
    RAILWAY_PROJECT_ID: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
    RAILWAY_GIT_COMMIT_SHA: 'a'.repeat(40),
    RAILWAY_SERVICE_ID: serviceId,
    RAILWAY_SERVICE_NAME: serviceName,
  };
}

function minimalSpawnEnvironment(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    PATHEXT: process.env.PATHEXT,
    SYSTEMROOT: process.env.SYSTEMROOT,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    WINDIR: process.env.WINDIR,
    ...validEnvironment(),
    ...overrides,
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

beforeAll(async () => {
  validator = await import(pathToFileURL(scriptPath).href) as ValidatorModule;
});

describe('Phase 2E inert migration validator boundary', () => {
  it('accepts exactly the five non-compensation operations', () => {
    expect(validator.parseValidatorOperation(['--plan'])).toBe('plan');
    expect(validator.parseValidatorOperation(['--apply'])).toBe('apply');
    expect(validator.parseValidatorOperation(['--verify'])).toBe('verify');
    expect(validator.parseValidatorOperation(['--verify-runtime'])).toBe('verify-runtime');
    expect(validator.parseValidatorOperation(['--drain'])).toBe('drain');

    for (const argv of [[], ['--compensate'], ['--plan', '--apply'], ['--unknown']]) {
      expect(() => validator.parseValidatorOperation(argv)).toThrow(
        'PHASE2E_VALIDATOR_ARGUMENT_INVALID',
      );
    }
  });

  it('requires PostgreSQL 18 public-schema identity for database operations', () => {
    expect(() => validator.validateDatabaseIdentityRows([{
      database_name: 'railway',
      schema_name: 'public',
      server_version: '18.4',
    }], 'railway')).not.toThrow();

    for (const rows of [
      [],
      [{ database_name: 'other', schema_name: 'public', server_version: '18.4' }],
      [{ database_name: 'railway', schema_name: 'other', server_version: '18.4' }],
      [{ database_name: 'railway', schema_name: 'public', server_version: '17.7' }],
    ]) {
      expect(() => validator.validateDatabaseIdentityRows(rows, 'railway')).toThrow(
        'PHASE2E_VALIDATOR_DATABASE_IDENTITY_MISMATCH',
      );
    }
  });

  it('requires exact preview project, environment, service, and source identity', () => {
    const accepted = validator.validateValidatorEnvironment(validEnvironment());
    expect(accepted).toMatchObject({
      projectId: validator.PHASE2E_VALIDATOR_PROJECT_ID,
      environmentId: validator.PHASE2E_VALIDATOR_ENVIRONMENT_ID,
      serviceId: validEnvironment().RAILWAY_SERVICE_ID,
    });

    for (const [key, value, code] of [
      ['RAILWAY_PROJECT_ID', '00000000-0000-4000-8000-000000000000', 'PHASE2E_VALIDATOR_PROJECT_MISMATCH'],
      ['RAILWAY_ENVIRONMENT_ID', '00000000-0000-4000-8000-000000000000', 'PHASE2E_VALIDATOR_ENVIRONMENT_MISMATCH'],
      ['RAILWAY_ENVIRONMENT_NAME', 'production', 'PHASE2E_VALIDATOR_PRODUCTION_FORBIDDEN'],
      ['RAILWAY_SERVICE_ID', '00000000-0000-4000-8000-000000000000', 'PHASE2E_VALIDATOR_SERVICE_MISMATCH'],
      ['RAILWAY_SERVICE_NAME', 'ARCANOS V2', 'PHASE2E_VALIDATOR_SERVICE_MISMATCH'],
      ['PHASE2E_VALIDATOR_EXPECTED_SOURCE_COMMIT', 'not-a-commit', 'PHASE2E_VALIDATOR_SOURCE_COMMIT_MISMATCH'],
      ['RAILWAY_GIT_COMMIT_SHA', 'b'.repeat(40), 'PHASE2E_VALIDATOR_SOURCE_COMMIT_MISMATCH'],
    ] as const) {
      expect(() => validator.validateValidatorEnvironment({
        ...validEnvironment(),
        [key]: value,
      })).toThrow(code);
    }

    const withoutRailwayCommit = validEnvironment();
    delete withoutRailwayCommit.RAILWAY_GIT_COMMIT_SHA;
    expect(() => validator.validateValidatorEnvironment(withoutRailwayCommit)).toThrow(
      'PHASE2E_VALIDATOR_SOURCE_COMMIT_MISMATCH'
    );
  });

  it('rejects public, option-bearing, non-Postgres, unauthenticated, and unnamed database URLs', () => {
    const rejectedUrls = [
      ['https://postgres.railway.internal/railway', 'PHASE2E_VALIDATOR_DATABASE_PROTOCOL_FORBIDDEN'],
      ['postgresql://user:secret@public.example.test/railway', 'PHASE2E_VALIDATOR_DATABASE_PRIVATE_HOST_REQUIRED'],
      ['postgresql://user:secret@postgres.railway.internal/railway?sslmode=require', 'PHASE2E_VALIDATOR_DATABASE_OPTIONS_FORBIDDEN'],
      ['postgresql://user:secret@postgres.railway.internal/railway#fragment', 'PHASE2E_VALIDATOR_DATABASE_OPTIONS_FORBIDDEN'],
      ['postgresql://postgres.railway.internal/railway', 'PHASE2E_VALIDATOR_DATABASE_CREDENTIAL_MISSING'],
      ['postgresql://user:secret@postgres.railway.internal', 'PHASE2E_VALIDATOR_DATABASE_NAME_MISSING'],
    ] as const;

    for (const [value, code] of rejectedUrls) {
      expect(() => validator.validatePrivateDatabaseUrl(value)).toThrow(code);
    }
  });

  it('fails closed when provider, Redis, application, worker, bridge, MCP, or healing variables exist', () => {
    for (const variableName of [
      'DATABASE_PUBLIC_URL',
      'REDIS_PUBLIC_URL',
      'REDIS_URL',
      'RAILWAY_PUBLIC_DOMAIN',
      'RAILWAY_TCP_PROXY_DOMAIN',
      'REDISPASSWORD',
      'OPENAI_API_KEY',
      'RAILWAY_OPENAI_API_KEY',
      'API_KEY',
      'ANTHROPIC_API_KEY',
      'AWS_SECRET_ACCESS_KEY',
      'UNRECOGNIZED_SERVICE_TOKEN',
      'ARCANOS_OPENAI_ROUTER',
      'ARCANOS_GPT_ACCESS_TOKEN',
      'ARCANOS_PROCESS_KIND',
      'RUN_WORKERS',
      'JOB_WORKER_CONCURRENCY',
      'ARCANOS_MCP_ENABLED',
      'ARCANOS_CLI_BRIDGE_ENABLED',
      'ARCANOS_HEALING_ENABLED',
      'PROVIDER_HEALTHCHECK_ENABLED',
      'ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL',
      'DATABASE_PRIVATE_URL',
      'SHADOW_DATABASE_URL',
      'PGOPTIONS',
      'PGSERVICE',
      'POSTGRES_PASSWORD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_EXTRA_CA_CERTS',
      'LD_PRELOAD',
      'DYLD_INSERT_LIBRARIES',
    ]) {
      expect(() => validator.validateValidatorEnvironment({
        ...validEnvironment(),
        [variableName]: '',
      })).toThrow('PHASE2E_VALIDATOR_FORBIDDEN_VARIABLE_PRESENT');
    }
  });

  it('fails the one-shot drain operation unless every drain predicate is safe', () => {
    const context = {
      projectId: validator.PHASE2E_VALIDATOR_PROJECT_ID,
      environmentId: validator.PHASE2E_VALIDATOR_ENVIRONMENT_ID,
      serviceId: validEnvironment().RAILWAY_SERVICE_ID,
      sourceCommit: 'a'.repeat(40),
    };
    const migration = {
      REVIEWED_MIGRATION_VERSION: '20260717_action_plan_execution_v2',
      REVIEWED_MIGRATION_CHECKSUM: 'b'.repeat(64),
    };
    expect(validator.safeOperationResult(context, 'drain', migration, {
      canDisableAssignment: true,
      canRevertApplication: true,
      canCompensateEmptySchema: true,
      counts: {},
    })).toMatchObject({ ok: true, code: 'PHASE2E_VALIDATOR_DRAIN_READY' });

    for (const blockedField of [
      'canDisableAssignment',
      'canRevertApplication',
      'canCompensateEmptySchema',
    ]) {
      expect(validator.safeOperationResult(context, 'drain', migration, {
        canDisableAssignment: true,
        canRevertApplication: true,
        canCompensateEmptySchema: true,
        [blockedField]: false,
        counts: {},
      })).toMatchObject({ ok: false, code: 'PHASE2E_VALIDATOR_DRAIN_BLOCKED' });
    }
  });

  it('completes plan mode without importing pg and emits no credential, URL, path, or stack', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'phase2e-validator-loader-'));
    const loaderPath = join(temporaryDirectory, 'poison-pg-loader.mjs');
    writeFileSync(loaderPath, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'pg') throw new Error('POISON_PG_IMPORT_REACHED');
        return nextResolve(specifier, context);
      }
    `, 'utf8');

    try {
      const result = spawnSync(process.execPath, [
        '--no-warnings',
        '--experimental-loader',
        pathToFileURL(loaderPath).href,
        scriptPath,
        '--plan',
      ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: minimalSpawnEnvironment(),
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        code: 'PHASE2E_VALIDATOR_PLAN_READY',
        operation: 'plan',
        sourceCommit: 'a'.repeat(40),
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(output).not.toContain(credentialSentinel);
      expect(output).not.toContain('postgresql://');
      expect(output).not.toContain('.railway.internal');
      expect(output).not.toContain(repositoryRoot);
      expect(output).not.toContain('POISON_PG_IMPORT_REACHED');
      expect(output).not.toContain(' at ');
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('rejects a wrong boundary before importing either migration or database code', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'phase2e-validator-boundary-'));
    const loaderPath = join(temporaryDirectory, 'poison-boundary-loader.mjs');
    writeFileSync(loaderPath, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'pg' || specifier.includes('action-plan-execution-migration.mjs')) {
          throw new Error('POISON_BOUNDARY_IMPORT_REACHED');
        }
        return nextResolve(specifier, context);
      }
    `, 'utf8');

    try {
      const result = spawnSync(process.execPath, [
        '--no-warnings',
        '--experimental-loader',
        pathToFileURL(loaderPath).href,
        scriptPath,
        '--apply',
      ], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: minimalSpawnEnvironment({ RAILWAY_PROJECT_ID: 'wrong-project' }),
      });

      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        code: 'PHASE2E_VALIDATOR_PROJECT_MISMATCH',
      });
      expect(result.stderr).not.toContain('POISON_BOUNDARY_IMPORT_REACHED');
      expect(result.stderr).not.toContain(credentialSentinel);
      expect(result.stderr).not.toContain(repositoryRoot);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('rejects Node preload injection before the Node validator process starts', () => {
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'phase2e-validator-pre-node-'));
    const preloadPath = join(temporaryDirectory, 'preload.mjs');
    const markerPath = join(temporaryDirectory, 'preload-ran');
    writeFileSync(
      preloadPath,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(markerPath)}, 'ran');\n`,
      'utf8',
    );
    try {
      const nodeOptions = `--import=${pathToFileURL(preloadPath).href}`;
      const result = spawnSync('bash', ['-lc', [
        `NODE_OPTIONS=${shellSingleQuote(nodeOptions)}`,
        'scripts/phase2e-validator-entrypoint.sh --plan',
      ].join(' ')], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        env: minimalSpawnEnvironment(),
        timeout: 5_000,
        windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(JSON.parse(result.stderr)).toEqual({
        ok: false,
        code: 'PHASE2E_VALIDATOR_PRE_NODE_ENVIRONMENT_FORBIDDEN',
      });
      expect(existsSync(markerPath)).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain(preloadPath);
    } finally {
      rmSync(temporaryDirectory, { force: true, recursive: true });
    }
  });

  it('maps arbitrary dependency failures to one fixed non-sensitive code', () => {
    const sensitiveError = Object.assign(
      new Error(`password=${credentialSentinel} path=${repositoryRoot} SQL=SELECT secret`),
      { code: 'ECONNREFUSED' },
    );
    expect(validator.safeFailureCode(sensitiveError)).toBe(
      'PHASE2E_VALIDATOR_OPERATION_FAILED',
    );
  });

  it('keeps the committed image and Railway target inert and source-minimal', () => {
    const script = readFileSync(scriptPath, 'utf8');
    const dockerfile = readFileSync(dockerfilePath, 'utf8');
    const railwayConfigs = operationConfigPaths.map(([operation, configPath]) => [
      operation,
      JSON.parse(readFileSync(configPath, 'utf8')) as {
        $schema: string;
        build: { builder: string; dockerfilePath: string };
        deploy: { startCommand: string; restartPolicyType: string };
      },
    ] as const);
    const railwayConfig = railwayConfigs[0][1];
    const staticImports = script.match(/^import .*;$/gmu) ?? [];

    expect(staticImports.join('\n')).toBe(
      "import { writeSync } from 'node:fs';\nimport process from 'node:process';\nimport { pathToFileURL } from 'node:url';",
    );
    expect(script).toContain("await import('pg')");
    expect(script).toContain('await import(MIGRATION_MODULE_URL.href)');
    expect(script).not.toContain('compensateMigrationWithClient');
    expect(script).not.toMatch(/\.(?:listen|createServer)\s*\(/u);
    expect(script).not.toMatch(/(?:start-server|daemon-python|src\/|workers\/|express)/u);

    expect(dockerfile).toContain('USER validator');
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/phase2e-validator-entrypoint.sh"]');
    expect(dockerfile).toContain('COPY --from=runtime-verifier-build /runtime-verifier-dist/ ./dist/core/db/');
    expect(dockerfile).toContain('COPY migrations/20260717_action_plan_execution_v2/');
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/mu);
    expect(dockerfile.match(/^COPY\s+src\//gmu)).toEqual([
      'COPY src/',
      'COPY src/',
    ]);
    expect(dockerfile).not.toMatch(/^COPY\s+(?:workers\/src|daemon-python|openapi|config)\//mu);
    expect(dockerfile).not.toMatch(/(?:start-railway-service|start-server|start:worker)/u);
    expect(dockerfile).toContain('RUN chmod 0555 /app/scripts/phase2e-validator-entrypoint.sh');

    expect(Object.keys(railwayConfig).sort()).toEqual(['$schema', 'build', 'deploy']);
    expect(railwayConfig.$schema).toBe('https://railway.com/railway.schema.json');
    expect(railwayConfig).toEqual(expect.objectContaining({
      build: {
        builder: 'DOCKERFILE',
        dockerfilePath: 'Dockerfile.phase2e-validator',
      },
      deploy: {
        startCommand: '/app/scripts/phase2e-validator-entrypoint.sh --plan',
        restartPolicyType: 'NEVER',
      },
    }));
    expect(railwayConfig.deploy).not.toHaveProperty('restartPolicyMaxRetries');
    for (const [operation, config] of railwayConfigs) {
      expect(Object.keys(config).sort()).toEqual(['$schema', 'build', 'deploy']);
      expect(config.$schema).toBe('https://railway.com/railway.schema.json');
      expect(config.build).toEqual({
        builder: 'DOCKERFILE',
        dockerfilePath: 'Dockerfile.phase2e-validator',
      });
      expect(config.deploy).toEqual({
        startCommand: `/app/scripts/phase2e-validator-entrypoint.sh --${operation}`,
        restartPolicyType: 'NEVER',
      });
    }
  });

  it('packages the real PostgreSQL 18 suite as a separate inert disposable-schema target', () => {
    const dockerfile = readFileSync(pg18DockerfilePath, 'utf8');
    const config = JSON.parse(readFileSync(pg18RailwayConfigPath, 'utf8')) as {
      $schema: string;
      build: { builder: string; dockerfilePath: string };
      deploy: { startCommand: string; restartPolicyType: string };
    };
    const entrypoint = readFileSync(entrypointPath, 'utf8');
    const jestConfig = readFileSync(
      join(repositoryRoot, 'jest.phase2e-pg18.config.js'),
      'utf8',
    );

    expect(dockerfile).toContain(
      'COPY tests/integration/action-plan-execution-migration.pg18.integration.test.ts',
    );
    expect(dockerfile).toContain('COPY jest.phase2e-pg18.config.js');
    expect(dockerfile).toContain('COPY scripts/phase2e-pg18-runner.mjs');
    expect(dockerfile).toContain('ENTRYPOINT ["/app/scripts/phase2e-validator-entrypoint.sh"]');
    expect(dockerfile).toContain('CMD ["--pg18-integration"]');
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/mu);
    expect(dockerfile).not.toMatch(/^COPY\s+(?:workers\/src|daemon-python|openapi)\//mu);
    expect(dockerfile).not.toMatch(/(?:start-railway-service|start-server|start:worker)/u);
    expect(entrypoint).toContain('node scripts/phase2e-migration-validator.mjs --plan');
    expect(entrypoint).toContain("ACTION_PLAN_EXECUTION_PG18_INTEGRATION:-}");
    expect(entrypoint).toContain("ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION:-}");
    expect(entrypoint).toContain('exec node scripts/phase2e-pg18-runner.mjs');
    expect(jestConfig).not.toContain('packages/cli/__tests__');
    expect(jestConfig).toContain(
      'action-plan-execution-migration.pg18.integration.test.ts',
    );
    expect(config).toEqual({
      $schema: 'https://railway.com/railway.schema.json',
      build: {
        builder: 'DOCKERFILE',
        dockerfilePath: 'Dockerfile.phase2e-postgres18-integration',
      },
      deploy: {
        startCommand: '/app/scripts/phase2e-validator-entrypoint.sh --pg18-integration',
        restartPolicyType: 'NEVER',
      },
    });
  });

  it('emits only bounded PostgreSQL 18 runner summaries and refuses skipped execution', async () => {
    const runner = await import(pathToFileURL(pg18RunnerPath).href) as {
      safePg18Result: (
        report: unknown,
        status: number | null,
        serverVersionNumber: number | null,
      ) => Record<string, unknown>;
    };
    expect(runner.safePg18Result({
      success: true,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numPassedTestSuites: 1,
      testResults: [{ message: `credential=${credentialSentinel} path=${repositoryRoot}` }],
    }, 0, 180004)).toEqual({
      ok: true,
      code: 'PHASE2E_PG18_INTEGRATION_PASS',
      passedTests: 1,
      passedSuites: 1,
      serverVersion: '18.4',
    });
    for (const report of [
      { success: true, numPassedTests: 0, numFailedTests: 0, numPendingTests: 1, numPassedTestSuites: 1 },
      { success: false, numPassedTests: 0, numFailedTests: 1, numPendingTests: 0, numPassedTestSuites: 0 },
      null,
    ]) {
      expect(runner.safePg18Result(report, 0, 180004)).toEqual({
        ok: false,
        code: 'PHASE2E_PG18_INTEGRATION_FAILED',
      });
    }
    expect(runner.safePg18Result({
      success: true,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      numPassedTestSuites: 1,
    }, 0, 170007)).toEqual({
      ok: false,
      code: 'PHASE2E_PG18_INTEGRATION_FAILED',
    });

    const spawned = spawnSync(process.execPath, [pg18RunnerPath], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: minimalSpawnEnvironment(),
      timeout: 5_000,
      windowsHide: true,
    });
    expect(spawned.status).toBe(1);
    expect(spawned.stdout).toBe('');
    expect(JSON.parse(spawned.stderr)).toEqual({
      ok: false,
      code: 'PHASE2E_PG18_INTEGRATION_FLAGS_REQUIRED',
    });
    expect(`${spawned.stdout}${spawned.stderr}`).not.toContain(credentialSentinel);
    expect(`${spawned.stdout}${spawned.stderr}`).not.toContain(repositoryRoot);
  });
});
