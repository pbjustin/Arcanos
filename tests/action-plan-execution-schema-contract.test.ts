import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const contractRelativePath = 'src/core/db/actionPlanExecutionSchemaContract.json';
const repositoryRoot = process.cwd();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function withFixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'arcanos-schema-contract-'));
  try {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('execution-free action-plan schema contract', () => {
  it('preserves every pre-refactor requirement, CHECK hash, and version field', () => {
    const contract = JSON.parse(readFileSync(join(repositoryRoot, contractRelativePath), 'utf8'));
    const digest = createHash('sha256')
      .update(JSON.stringify(canonicalize(contract)))
      .digest('hex');

    // Captured from the independent implementations at main 48589f2ad696d33b69a3a413fdd03c659a889352.
    expect(digest).toBe('09b6cb4a58be276d20b959271471c52700edc6b90a255002cb87b2143fc421b9');
  });

  it('runs the complete offline migration plan without dependencies or runtime modules', () => {
    withFixture(root => {
      for (const relative of [
        'scripts/action-plan-execution-migration.mjs',
        'scripts/action-plan-execution-migration-history.mjs',
        contractRelativePath,
        'migrations/20260717_action_plan_execution_v2',
        'migrations/20260718_action_plan_execution_migration_history_v1'
      ]) {
        cpSync(join(repositoryRoot, relative), join(root, relative), { recursive: true });
      }
      // The fixture has no node_modules and fails immediately if runtime code is imported.
      writeFileSync(join(root, 'src/core/db/client.js'), 'throw new Error("RUNTIME_IMPORT_FORBIDDEN");\n');
      const result = spawnSync(process.execPath, [
        join(root, 'scripts/action-plan-execution-migration.mjs'), '--plan'
      ], {
        cwd: root,
        encoding: 'utf8',
        env: { PATH: process.env.PATH, ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL: 'invalid-target' }
      });

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: true,
        version: '20260717_action_plan_execution_v2',
        checksum: 'cfa339af4282ce47a955acd08fa3f16e617b4a943111890f1e5b4bd5ba929533',
        issues: [],
        databaseConnected: false,
        databaseMutated: false,
        history: { issues: [] }
      });

      const apply = spawnSync(process.execPath, [
        join(root, 'scripts/action-plan-execution-migration.mjs'), '--apply'
      ], { cwd: root, encoding: 'utf8', env: {} });
      expect(apply.status).toBe(2);
      expect(JSON.parse(apply.stdout)).toMatchObject({
        code: 'MIGRATION_LOCAL_CONFIRMATION_REQUIRED', databaseMutated: false
      });
    });
  });

  it('emits and imports the contract through the existing TypeScript JSON build path', () => {
    withFixture(root => {
      mkdirSync(join(root, 'src'), { recursive: true });
      cpSync(join(repositoryRoot, contractRelativePath), join(root, 'src/contract.json'));
      writeFileSync(join(root, 'src/consumer.ts'), [
        "import contract from './contract.json' with { type: 'json' };",
        'console.log(JSON.stringify(contract));'
      ].join('\n'));
      writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({
        compilerOptions: {
          module: 'NodeNext', moduleResolution: 'NodeNext', resolveJsonModule: true,
          rootDir: 'src', outDir: 'dist', skipLibCheck: true
        }, include: ['src']
      }));
      const compilation = spawnSync(process.execPath, [
        join(repositoryRoot, 'node_modules/typescript/bin/tsc'), '-p', join(root, 'tsconfig.json')
      ], { cwd: root, encoding: 'utf8' });
      expect(compilation.stdout + compilation.stderr).toBe('');
      expect(compilation.status).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'dist/contract.json'), 'utf8'))).toEqual(
        JSON.parse(readFileSync(join(root, 'src/contract.json'), 'utf8'))
      );
      const execution = spawnSync(process.execPath, [join(root, 'dist/consumer.js')], {
        cwd: root, encoding: 'utf8', env: {}
      });
      expect(execution.stderr).toBe('');
      expect(execution.status).toBe(0);
      expect(JSON.parse(execution.stdout)).toEqual(
        JSON.parse(readFileSync(join(repositoryRoot, contractRelativePath), 'utf8'))
      );
    });
  });

  it('compiles the actual verifier with the validator image flags and imports its emitted contract', () => {
    withFixture(root => {
      for (const relative of [
        'src/core/db/actionPlanExecutionSchema.ts', 'src/core/db/client.ts', contractRelativePath
      ]) {
        cpSync(join(repositoryRoot, relative), join(root, relative));
      }
      symlinkSync(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
      const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile.phase2e-validator'), 'utf8');
      const compileStep = dockerfile.match(/RUN \.\/node_modules\/\.bin\/tsc ([\s\S]*?)\s+&& npm prune/u)?.[1];
      expect(compileStep).toBeDefined();
      const args = compileStep!.replace(/\\\s*(?:\n|$)/gu, ' ').trim().split(/\s+/u)
        .map(argument => argument === '/runtime-verifier-dist' ? join(root, 'dist') : argument);
      const compilation = spawnSync(process.execPath, [
        join(repositoryRoot, 'node_modules/typescript/bin/tsc'), ...args
      ], { cwd: root, encoding: 'utf8' });
      expect(compilation.stdout + compilation.stderr).toBe('');
      expect(compilation.status).toBe(0);
      expect(JSON.parse(readFileSync(join(root, 'dist/actionPlanExecutionSchemaContract.json'), 'utf8')))
        .toEqual(JSON.parse(readFileSync(join(repositoryRoot, contractRelativePath), 'utf8')));
      const execution = spawnSync(process.execPath, ['--input-type=module', '-e', [
        "import { verifyConfiguredActionPlanExecutionSchema } from './dist/actionPlanExecutionSchema.js';",
        'console.log(JSON.stringify(await verifyConfiguredActionPlanExecutionSchema()));'
      ].join('\n')], { cwd: root, encoding: 'utf8', env: {} });
      expect(execution.status).toBe(0);
      expect(execution.stderr).toBe('');
      expect(JSON.parse(execution.stdout)).toMatchObject({
        ready: false, code: 'ACTION_PLAN_EXECUTION_SCHEMA_UNAVAILABLE', issues: ['SCHEMA_POOL_UNAVAILABLE']
      });
    });
  });
});
