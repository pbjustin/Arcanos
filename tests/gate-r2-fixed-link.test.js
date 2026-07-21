import { describe, expect, it, jest } from '@jest/globals';
import { join } from 'node:path';
import {
  GATE_R2_FIXED_LINK_ENVIRONMENT_ID,
  GATE_R2_FIXED_LINK_ENVIRONMENT_NAME,
  GATE_R2_FIXED_LINK_JSON_MAX_BYTES,
  GATE_R2_FIXED_LINK_PROJECT_ID,
  GATE_R2_FIXED_LINK_PROJECT_NAME,
  assertGateR2FixedLink,
  removeGateR2ScratchDirectory
} from '../scripts/gate-r2-fixed-link.js';

const TEST_RAILWAY_EXECUTABLE = 'C:\\fixed\\railway.exe';
const TEST_TEMP_ROOT = 'C:\\fixed-temp';
const TEST_SCRATCH = join(TEST_TEMP_ROOT, `arcanos-gate-r-${'a'.repeat(32)}`);
const SECRET_SENTINEL = 'fixed-link-secret-must-not-escape';
const FAILURE_CODE = 'GATE_R2_TEST_TARGET_MISMATCH';
const TIMEOUT_CODE = 'GATE_R2_TEST_TIMEOUT';

function humanStatusBuffer({
  project = GATE_R2_FIXED_LINK_PROJECT_NAME,
  environment = GATE_R2_FIXED_LINK_ENVIRONMENT_NAME,
  service = 'None'
} = {}) {
  return Buffer.from(`Project: ${project}\nEnvironment: ${environment}\nService: ${service}\n`);
}

function jsonLinkBuffer({
  projectId = GATE_R2_FIXED_LINK_PROJECT_ID,
  projectName = GATE_R2_FIXED_LINK_PROJECT_NAME,
  environmentId = GATE_R2_FIXED_LINK_ENVIRONMENT_ID,
  environmentName = GATE_R2_FIXED_LINK_ENVIRONMENT_NAME,
  extra = {}
} = {}) {
  return Buffer.from(JSON.stringify({
    projectId,
    projectName,
    environmentId,
    environmentName,
    ...extra
  }));
}

function expectZeroed(buffer) {
  expect([...buffer]).toEqual(new Array(buffer.length).fill(0));
}

function invoke(spawn, overrides = {}) {
  return assertGateR2FixedLink({
    railwayExecutable: TEST_RAILWAY_EXECUTABLE,
    childEnvironment: { PATH: 'C:\\safe' },
    failureCode: FAILURE_CODE,
    timeoutCode: TIMEOUT_CODE,
    spawn,
    createScratch: jest.fn(() => TEST_SCRATCH),
    removeScratch: jest.fn(),
    temporaryRoot: TEST_TEMP_ROOT,
    ...overrides
  });
}

describe('Gate R2 exact fixed-link verifier', () => {
  it('links only the fixed IDs in an isolated scratch and then verifies human status', () => {
    const linkStdout = jsonLinkBuffer();
    const humanStdout = humanStatusBuffer();
    const createScratch = jest.fn(() => TEST_SCRATCH);
    const removeScratch = jest.fn();
    const operation = jest.fn(() => 'operation-result');
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: humanStdout, stderr: Buffer.alloc(0) });

    expect(invoke(spawn, { createScratch, removeScratch, operation })).toBe('operation-result');
    expect(createScratch).toHaveBeenCalledWith(TEST_TEMP_ROOT);
    expect(removeScratch).toHaveBeenCalledWith(TEST_SCRATCH, TEST_TEMP_ROOT);
    expect(operation).toHaveBeenCalledWith(TEST_SCRATCH);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0][1]).toEqual([
      'link',
      '-p', GATE_R2_FIXED_LINK_PROJECT_ID,
      '-e', GATE_R2_FIXED_LINK_ENVIRONMENT_ID,
      '--json'
    ]);
    expect(spawn.mock.calls[1][1]).toEqual(['status']);
    for (const call of spawn.mock.calls) {
      expect(call[2]).toMatchObject({
        cwd: TEST_SCRATCH,
        env: { PATH: 'C:\\safe' },
        shell: false,
        timeout: 30_000,
        windowsHide: true
      });
    }
    expect(spawn.mock.calls[0][2].maxBuffer).toBe(GATE_R2_FIXED_LINK_JSON_MAX_BYTES);
    expectZeroed(linkStdout);
    expectZeroed(humanStdout);
  });

  it.each([
    ['wrong project id', { projectId: '11111111-2222-4333-8444-555555555555' }],
    ['wrong project name', { projectName: 'Another' }],
    ['wrong environment id', { environmentId: '11111111-2222-4333-8444-555555555555' }],
    ['wrong environment name', { environmentName: 'production' }],
    ['extra secret field', {
      extra: Object.fromEntries([[['to', 'ken'].join(''), SECRET_SENTINEL]])
    }]
  ])('rejects %s and wipes the link projection', (_name, overrides) => {
    const linkStdout = jsonLinkBuffer(overrides);
    const spawn = jest.fn(() => ({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) }));

    expect(() => invoke(spawn)).toThrow(FAILURE_CODE);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(linkStdout);
  });

  it.each([
    ['malformed JSON', Buffer.from(`{"sentinel":"${SECRET_SENTINEL}"`) ],
    ['non-object JSON', Buffer.from('[]')],
    ['oversized JSON', Buffer.alloc(GATE_R2_FIXED_LINK_JSON_MAX_BYTES + 1, 0x41)],
    ['secret-bearing unexpected shape', Buffer.from(JSON.stringify(
      Object.fromEntries([[['sec', 'ret'].join(''), SECRET_SENTINEL]])
    ))]
  ])('rejects %s without exposing child data', (_name, linkStdout) => {
    const spawn = jest.fn(() => ({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) }));

    expect(() => invoke(spawn)).toThrow(FAILURE_CODE);
    expectZeroed(linkStdout);
  });

  it.each([
    ['repository cwd', 'C:\\pbjustin\\Arcanos-phase2e-advisory-history-gate-r'],
    ['wrong temp root', join('C:\\other-temp', `arcanos-gate-r-${'a'.repeat(32)}`)],
    ['near-prefix', join(TEST_TEMP_ROOT, `arcanos-gate-r2-${'a'.repeat(32)}`)],
    ['nested scratch', join(TEST_SCRATCH, `arcanos-gate-r-${'b'.repeat(32)}`)]
  ])('rejects %s before invoking Railway', (_name, scratch) => {
    const spawn = jest.fn();
    const removeScratch = jest.fn();
    expect(() => invoke(spawn, {
      createScratch: jest.fn(() => scratch),
      removeScratch
    })).toThrow(FAILURE_CODE);
    expect(spawn).not.toHaveBeenCalled();
    expect(removeScratch).toHaveBeenCalledWith(scratch, TEST_TEMP_ROOT);
  });

  it('rejects wrong human context after linking and wipes both outputs', () => {
    const linkStdout = jsonLinkBuffer();
    const humanStdout = humanStatusBuffer({ environment: 'production' });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 0, stdout: linkStdout, stderr: Buffer.alloc(0) })
      .mockReturnValueOnce({ status: 0, stdout: humanStdout, stderr: Buffer.alloc(0) });

    expect(() => invoke(spawn)).toThrow(FAILURE_CODE);
    expect(spawn).toHaveBeenCalledTimes(2);
    expectZeroed(linkStdout);
    expectZeroed(humanStdout);
  });

  it('maps link timeouts to a fixed caller-selected code and wipes diagnostics', () => {
    const stderr = Buffer.from(SECRET_SENTINEL);
    const timeout = Object.assign(new Error(SECRET_SENTINEL), {
      code: 'ETIMEDOUT',
      stderr
    });
    const spawn = jest.fn(() => { throw timeout; });

    expect(() => invoke(spawn)).toThrow(TIMEOUT_CODE);
    expect(spawn).toHaveBeenCalledTimes(1);
    expectZeroed(stderr);
  });

  it('revalidates the scratch identity immediately before recursive removal', () => {
    const remove = jest.fn();
    const realpath = jest.fn(value => value === TEST_TEMP_ROOT ? TEST_TEMP_ROOT : TEST_SCRATCH);
    removeGateR2ScratchDirectory({
      path: TEST_SCRATCH,
      temporaryRoot: TEST_TEMP_ROOT,
      lstat: jest.fn(() => ({ isDirectory: () => true, isSymbolicLink: () => false })),
      realpath,
      remove
    });
    expect(remove).toHaveBeenCalledWith(TEST_SCRATCH, { force: true, recursive: true });
  });

  it.each([
    ['reparse point', { isDirectory: () => true, isSymbolicLink: () => true }, TEST_SCRATCH],
    ['non-directory', { isDirectory: () => false, isSymbolicLink: () => false }, TEST_SCRATCH],
    ['junction target', { isDirectory: () => true, isSymbolicLink: () => false }, 'C:\\outside\\target']
  ])('refuses recursive removal for a %s', (_name, stat, canonicalPath) => {
    const remove = jest.fn();
    expect(() => removeGateR2ScratchDirectory({
      path: TEST_SCRATCH,
      temporaryRoot: TEST_TEMP_ROOT,
      lstat: jest.fn(() => stat),
      realpath: jest.fn(value => value === TEST_TEMP_ROOT ? TEST_TEMP_ROOT : canonicalPath),
      remove
    })).toThrow('GATE_R2_FIXED_LINK_CLEANUP_INVALID');
    expect(remove).not.toHaveBeenCalled();
  });
});
