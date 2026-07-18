#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPORT_PATH = '/tmp/phase2e-pg18-jest-result.json';

export function safePg18Result(jestReport, exitStatus) {
  const passed = Number(jestReport?.numPassedTests);
  const failed = Number(jestReport?.numFailedTests);
  const skipped = Number(jestReport?.numPendingTests);
  const suitesPassed = Number(jestReport?.numPassedTestSuites);
  const ok = (
    exitStatus === 0
    && jestReport?.success === true
    && Number.isSafeInteger(passed)
    && passed > 0
    && failed === 0
    && skipped === 0
    && Number.isSafeInteger(suitesPassed)
    && suitesPassed > 0
  );
  return ok
    ? {
        ok: true,
        code: 'PHASE2E_PG18_INTEGRATION_PASS',
        passedTests: passed,
        passedSuites: suitesPassed,
      }
    : { ok: false, code: 'PHASE2E_PG18_INTEGRATION_FAILED' };
}

function writeResultAndExit(result) {
  const stream = result.ok === true ? process.stdout : process.stderr;
  writeSync(stream.fd, `${JSON.stringify(result)}\n`);
  process.exit(result.ok === true ? 0 : 1);
}

function main() {
  if (
    process.env.ACTION_PLAN_EXECUTION_PG18_INTEGRATION !== '1'
    || process.env.ACTION_PLAN_EXECUTION_PG18_RAILWAY_VALIDATION !== '1'
  ) {
    writeResultAndExit({ ok: false, code: 'PHASE2E_PG18_INTEGRATION_FLAGS_REQUIRED' });
  }

  rmSync(REPORT_PATH, { force: true });
  const child = spawnSync(process.execPath, [
    '--disable-warning=ExperimentalWarning',
    '--experimental-vm-modules',
    'node_modules/jest/bin/jest.js',
    '--config=jest.phase2e-pg18.config.js',
    '--runInBand',
    '--detectOpenHandles',
    '--json',
    `--outputFile=${REPORT_PATH}`,
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });

  let report = null;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
  } catch {
    report = null;
  } finally {
    rmSync(REPORT_PATH, { force: true });
  }
  writeResultAndExit(safePg18Result(report, child.status));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
