import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const repositoryRoot = process.cwd();
const scriptPath = join(repositoryRoot, 'scripts', 'phase2e-migration-validator.mjs');
const dockerfilePath = join(repositoryRoot, 'Dockerfile.phase2e-validator');
const railwayConfigPath = join(repositoryRoot, 'railway.phase2e-validator.json');
const credentialSentinel = 'PHASE2E_VALIDATOR_CREDENTIAL_SENTINEL';

interface ValidatorModule {
  PHASE2E_VALIDATOR_ENVIRONMENT_ID: string;
  PHASE2E_VALIDATOR_ENVIRONMENT_NAME: string;
  PHASE2E_VALIDATOR_PROJECT_ID: string;
  parseValidatorOperation: (argv: string[]) => 'plan' | 'apply' | 'verify' | 'drain';
  safeOperationResult: (
    context: Record<string, string>,
    operation: 'drain',
    migration: Record<string, string | number>,
    result: Record<string, unknown>
  ) => { ok: boolean; code: string };
  safeFailureCode: (error: unknown) => string;
  validatePrivateDatabaseUrl: (value: unknown) => string;
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
      `postgresql://validator:${credentialSentinel}@postgres.railway.internal:5432/railway`,
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

beforeAll(async () => {
  validator = await import(pathToFileURL(scriptPath).href) as ValidatorModule;
});

describe('Phase 2E inert migration validator boundary', () => {
  it('accepts exactly the four non-compensation operations', () => {
    expect(validator.parseValidatorOperation(['--plan'])).toBe('plan');
    expect(validator.parseValidatorOperation(['--apply'])).toBe('apply');
    expect(validator.parseValidatorOperation(['--verify'])).toBe('verify');
    expect(validator.parseValidatorOperation(['--drain'])).toBe('drain');

    for (const argv of [[], ['--compensate'], ['--plan', '--apply'], ['--unknown']]) {
      expect(() => validator.parseValidatorOperation(argv)).toThrow(
        'PHASE2E_VALIDATOR_ARGUMENT_INVALID',
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
    const railwayConfig = JSON.parse(readFileSync(railwayConfigPath, 'utf8')) as {
      build: { builder: string; dockerfilePath: string };
      deploy: { startCommand: string; restartPolicyType: string };
    };
    const staticImports = script.match(/^import .*;$/gmu) ?? [];

    expect(staticImports.join('\n')).toBe(
      "import process from 'node:process';\nimport { pathToFileURL } from 'node:url';",
    );
    expect(script).toContain("await import('pg')");
    expect(script).toContain('await import(MIGRATION_MODULE_URL.href)');
    expect(script).not.toContain('compensateMigrationWithClient');
    expect(script).not.toMatch(/\.(?:listen|createServer)\s*\(/u);
    expect(script).not.toMatch(/(?:start-server|daemon-python|src\/|workers\/|express)/u);

    expect(dockerfile).toContain('USER validator');
    expect(dockerfile).toContain('COPY migrations/20260717_action_plan_execution_v2/');
    expect(dockerfile).not.toMatch(/^COPY\s+\.\s/mu);
    expect(dockerfile).not.toMatch(/^COPY\s+(?:src|workers\/src|daemon-python|openapi|config)\//mu);
    expect(dockerfile).not.toMatch(/(?:start-railway-service|start-server|start:worker)/u);

    expect(Object.keys(railwayConfig).sort()).toEqual(['$schema', 'build', 'deploy']);
    expect(railwayConfig.$schema).toBe('https://railway.com/railway.schema.json');
    expect(railwayConfig).toEqual(expect.objectContaining({
      build: {
        builder: 'DOCKERFILE',
        dockerfilePath: 'Dockerfile.phase2e-validator',
      },
      deploy: {
        startCommand: 'node scripts/phase2e-migration-validator.mjs --plan',
        restartPolicyType: 'NEVER',
      },
    }));
    expect(railwayConfig.deploy).not.toHaveProperty('restartPolicyMaxRetries');
  });
});
