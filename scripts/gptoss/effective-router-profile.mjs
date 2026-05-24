#!/usr/bin/env node
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const CURRENT_REPORT =
  'local_artifacts/gptoss-phase3-8-lowlr/eval-router-classifier-effective-spec-current.json';

const EVAL_ARGS = [
  'scripts/gptoss/eval-adapter-local.mjs',
  '--execute',
  '--router-classifier-mode',
  '--prefill-json-start',
  '--apply-hard-policy-overrides',
  '--use-local-spec-facts',
  '--adapter-dir',
  'local_artifacts/gptoss-phase3-8-lowlr',
  '--eval-file',
  'examples/gptoss/arcanos-eval-smoke.jsonl',
  '--output',
  CURRENT_REPORT,
  '--temperature',
  '0',
  '--max-new-tokens',
  '32',
  '--repetition-penalty',
  '1.3',
];

function runEval() {
  rmSync(CURRENT_REPORT, { force: true });
  const result = spawnSync(process.execPath, EVAL_ARGS, {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });

  if (!existsSync(CURRENT_REPORT)) {
    process.exit(result.status ?? 1);
  }
}

function runRegression() {
  const result = spawnSync(process.execPath, [
    'scripts/gptoss/baseline-registry.mjs',
    'regress',
    '--report',
    CURRENT_REPORT,
  ], {
    cwd: process.cwd(),
    env: process.env,
    stdio: 'inherit',
  });
  process.exit(result.status ?? 1);
}

async function main() {
  const command = process.argv[2] || 'eval';
  if (!['eval', 'regress'].includes(command)) {
    throw new Error(`Unknown effective-router profile command: ${command}`);
  }

  runEval();
  if (command === 'regress') {
    runRegression();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  });
}
