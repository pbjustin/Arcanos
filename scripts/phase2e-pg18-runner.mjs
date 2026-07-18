#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const REPORT_PATH = '/tmp/phase2e-pg18-jest-result.json';
const SERVER_REPORT_PATH = '/tmp/phase2e-pg18-server-version.json';

export function safePg18Result(jestReport, exitStatus, serverVersionNumber) {
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
    && Number.isSafeInteger(serverVersionNumber)
    && serverVersionNumber >= 180000
    && serverVersionNumber < 190000
  );
  const serverVersion = ok
    ? `${Math.floor(serverVersionNumber / 10_000)}.${serverVersionNumber % 10_000}`
    : null;
  return ok
    ? {
        ok: true,
        code: 'PHASE2E_PG18_INTEGRATION_PASS',
        passedTests: passed,
        passedSuites: suitesPassed,
        serverVersion,
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
  rmSync(SERVER_REPORT_PATH, { force: true });
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
    env: {
      ...process.env,
      PHASE2E_PG18_SAFE_VERSION_REPORT_PATH: SERVER_REPORT_PATH,
    },
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
  });

  let report = null;
  let serverVersionNumber = null;
  try {
    report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
    const serverReport = JSON.parse(readFileSync(SERVER_REPORT_PATH, 'utf8'));
    serverVersionNumber = Number(serverReport?.serverVersionNumber);
  } catch {
    report = null;
    serverVersionNumber = null;
  } finally {
    rmSync(REPORT_PATH, { force: true });
    rmSync(SERVER_REPORT_PATH, { force: true });
  }
  writeResultAndExit(safePg18Result(report, child.status, serverVersionNumber));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
