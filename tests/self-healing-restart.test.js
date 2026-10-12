import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));

// Two genuine Node processes load current source without a server, worker,
// provider or persistence adapter. Only this reviewed config/logging graph is
// admitted; its sole dotenv read is confined to a new empty working directory.
const reviewedSourceFiles = [
  'src/services/selfImprove/selfHealingV2.ts',
  'src/platform/runtime/unifiedConfig.ts',
  'src/platform/runtime/env.ts',
  'src/platform/logging/structuredLogging.ts',
  'src/platform/logging/logger.ts',
  'src/platform/logging/telemetry.ts',
  'src/shared/constants.ts',
  'src/shared/idGenerator.ts',
  'src/shared/redaction.ts',
  'src/shared/errorUtils.ts',
  'src/shared/security/purposeBoundCredential.ts',
  'src/shared/security/opaqueSecret.ts',
  'packages/arcanos-runtime/src/redaction.ts'
];

function runFreshProcess(cwd, activate) {
  const program = `
    import { registerHooks } from 'node:module';
    import { readFileSync } from 'node:fs';
    import path from 'node:path';
    import { fileURLToPath, pathToFileURL } from 'node:url';
    import ts from ${JSON.stringify(path.join(repositoryRoot, 'node_modules/typescript/lib/typescript.js'))};
    const root = ${JSON.stringify(repositoryRoot)};
    const reviewed = new Set(${JSON.stringify(reviewedSourceFiles)}.map(file => path.join(root, file)));
    const builtinModules = new Set(['module', 'fs', 'path', 'url', 'events', 'crypto', 'os', 'util']);
    registerHooks({
      resolve(specifier, context, nextResolve) {
        let source;
        if (specifier === '@arcanos/runtime/redaction') {
          source = path.join(root, 'packages/arcanos-runtime/src/redaction.ts');
        } else if (specifier.startsWith('@platform/') || specifier.startsWith('@shared/')) {
          source = path.join(root, 'src', specifier.slice(1).replace(/\\.js$/, '.ts'));
        } else if (specifier.startsWith('file:')) {
          source = fileURLToPath(specifier);
        } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
          source = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\\.js$/, '.ts');
        }
        if (source && reviewed.has(source)) {
          return { url: pathToFileURL(source).href, shortCircuit: true };
        }
        if (source === path.join(root, 'node_modules/dotenv/package.json')) {
          return nextResolve(specifier, context);
        }
        if (specifier === 'dotenv') {
          return nextResolve(pathToFileURL(path.join(root, 'node_modules/dotenv/lib/main.js')).href, context);
        }
        if (builtinModules.has(specifier.replace(/^node:/, ''))) return nextResolve(specifier, context);
        throw new Error('Restart fixture rejected an unreviewed module.');
      },
      load(url, context, nextLoad) {
        if (url.startsWith('file:') && reviewed.has(fileURLToPath(url))) {
          const source = ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), {
            compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }
          }).outputText;
          return { format: 'module', source, shortCircuit: true };
        }
        return nextLoad(url, context);
      }
    });
    globalThis.fetch = async () => { throw new Error('Restart fixture forbids network.'); };
    const healing = await import(pathToFileURL(path.join(root, 'src/services/selfImprove/selfHealingV2.ts')).href);
    const before = healing.getTrinitySelfHealingSnapshot();
    if (${JSON.stringify(activate)}) {
      for (let index = 0; index < 3; index += 1) {
        healing.recordTrinityStageFailure({ stage: 'reasoning', error: 'synthetic local abort', requestId: 'restart-' + index });
      }
    }
    console.log(JSON.stringify({
      pid: process.pid, enabled: healing.getTrinitySelfHealingStatus().enabled,
      before, after: healing.getTrinitySelfHealingSnapshot(),
      consumer: healing.getTrinitySelfHealingMitigation({ tier: 'simple', answerMode: 'explained' }),
      environmentNames: Object.keys(process.env).sort()
    }));
  `;
  // No spread of process.env: no parent credentials, NODE_OPTIONS, target IDs,
  // database/Redis URLs or webhook configuration can reach either process.
  const env = {
    NODE_ENV: 'test', LOG_LEVEL: 'error', DOTENV_CONFIG_QUIET: 'true',
    ARCANOS_PROCESS_KIND: 'worker', RUN_WORKERS: 'false',
    FINETUNED_MODEL_ID: 'ft:gpt-4.1:synthetic:restart-consumer',
    OPENAI_API_KEY: 'test-self-healing-restart-api-key',
    SELF_IMPROVE_ENABLED: 'true', SELF_IMPROVE_ACTUATOR_MODE: 'daemon',
    SELF_IMPROVE_AUTONOMY_LEVEL: '3', SELF_IMPROVE_FREEZE: 'false'
  };
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', program], {
    cwd, env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const result = JSON.parse(output.trim());
  expect(result.environmentNames).toEqual(Object.keys(env).sort());
  return result;
}

describe('self-healing restart isolation', () => {
  it('invalidates an active mitigation in a genuinely fresh process instead of replaying it', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'arcanos-self-heal-restart-'));
    try {
      const incidentProcess = runFreshProcess(cwd, true);
      expect(incidentProcess.enabled).toBe(true);
      expect(incidentProcess.after.reasoning).toMatchObject({
        activeAction: 'enable_degraded_mode', attempts: 1
      });
      expect(incidentProcess.consumer).toMatchObject({ forceDirectAnswer: true, verified: false });

      const restartedProcess = runFreshProcess(cwd, false);
      expect(restartedProcess.pid).not.toBe(incidentProcess.pid);
      expect(restartedProcess.enabled).toBe(true);
      for (const stage of Object.values(restartedProcess.after)) {
        expect(stage).toMatchObject({
          observations: [], attempts: 0, activeAction: null, expiresAtMs: null,
          verificationSuccesses: 0, verificationFailures: 0, cooldownUntilMs: null, failedActions: []
        });
      }
      expect(restartedProcess.consumer).toMatchObject({
        activeAction: null, forceDirectAnswer: false, bypassFinalStage: false, verified: false
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
