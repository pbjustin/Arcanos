import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  PROBE_STATUS,
  buildFailure,
  buildSuccess,
  createRequestTimeoutSignal,
  isDirectExecution,
  normalizeBaseUrl,
  parseProbeArgs,
  printProbeResult,
  readJsonResponse,
  readPositiveInteger,
} from '../scripts/lib/railway-probe.mjs';
import { DEFAULTS as FAST_DEFAULTS, parseArgs as parseFastArgs } from '../scripts/railway-fast-path-probe.js';
import { DEFAULTS as ASYNC_DEFAULTS, parseArgs as parseAsyncArgs } from '../scripts/railway-async-job-probe.js';
import { createProbeResponse } from './fixtures/railway-probe-responses.js';

afterEach(() => {
  jest.useRealTimers();
});

describe('shared Railway probe infrastructure', () => {
  it.each([
    ['42', 42], ['2.9', 2], ['0.5', 0], [' 5 ', 5], ['1e2', 100], ['0x10', 16],
    ['0', 17], ['-1', 17], ['', 17], [' ', 17], ['bad', 17], ['Infinity', 17],
    [undefined, 17], [null, 17],
  ])('preserves positive-integer parsing for %p', (rawValue, expected) => {
    expect(readPositiveInteger(rawValue, 17)).toBe(expected);
  });

  it.each([
    [' example.com/// ', 'https://example.com'],
    ['http://example.com/', 'http://example.com'],
    ['HTTPS://example.com///', 'HTTPS://example.com'],
    ['', 'https://'],
  ])('preserves URL normalization for %p', (rawValue, expected) => {
    expect(normalizeBaseUrl(rawValue)).toBe(expected);
  });

  it.each([
    ['fast', FAST_DEFAULTS, parseFastArgs],
    ['async', ASYNC_DEFAULTS, parseAsyncArgs],
  ])('preserves shared CLI flag handling for the %s probe', (_name, defaults, parse) => {
    expect(parse(['--base-url', ' example.com/ ', '--gpt-id', ' custom ', '--prompt', ' PONG ',
      '--request-timeout-ms', '4.9', '--unknown', 'ignored'])).toEqual({
      ...defaults, baseUrl: 'example.com/', gptId: 'custom', prompt: 'PONG', requestTimeoutMs: 4,
    });
    expect(parse(['--base-url', ' ', '--request-timeout-ms', 'bad', '--prompt'])).toEqual(defaults);
    expect(parse(['--base-url', '--prompt', '--gpt-id', 'custom'])).toEqual({
      ...defaults, baseUrl: '--prompt', gptId: 'custom',
    });
    expect(parse(['--unknown', '--prompt', ' PONG '])).toEqual({ ...defaults, prompt: 'PONG' });
    expect(parse(['--toString', 'ignored', '--constructor', 'ignored'])).toEqual(defaults);
  });

  it('keeps async-only flags out of the fast-path parser', () => {
    const argv = ['--timeout-ms', '4.5', '--poll-interval-ms', 'bad'];
    expect(parseFastArgs(argv)).toEqual(FAST_DEFAULTS);
    expect(parseAsyncArgs(argv)).toEqual({ ...ASYNC_DEFAULTS, timeoutMs: 4 });
    expect(parseProbeArgs([], FAST_DEFAULTS)).not.toBe(FAST_DEFAULTS);
  });

  it.each(['', ' \n ', '{broken', '<html>fixture</html>'])('retains unsuccessful JSON response text %p', async (bodyText) => {
    await expect(readJsonResponse(createProbeResponse({ bodyText }))).resolves.toEqual({
      ok: false, bodyText, parsedBody: null,
    });
  });

  it.each(['{}', '[]', 'null', 'false', '1', '"fixture"'])('parses JSON independently of payload validation: %s', async (bodyText) => {
    await expect(readJsonResponse(createProbeResponse({ bodyText }))).resolves.toEqual({
      ok: true, bodyText, parsedBody: JSON.parse(bodyText),
    });
  });

  it('propagates response body read failures', async () => {
    const error = new Error('fixture body read failure');
    await expect(readJsonResponse({ text: async () => { throw error; } })).rejects.toBe(error);
  });

  it('aborts at the configured deadline and permits cleanup after abort', () => {
    jest.useFakeTimers();
    const timeout = createRequestTimeoutSignal(25);
    jest.advanceTimersByTime(24);
    expect(timeout.signal.aborted).toBe(false);
    jest.advanceTimersByTime(1);
    expect(timeout.signal.aborted).toBe(true);
    timeout.dispose();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('clears a timeout on disposal without aborting its signal', () => {
    jest.useFakeTimers();
    const timeout = createRequestTimeoutSignal(25);
    timeout.dispose();
    timeout.dispose();
    jest.advanceTimersByTime(25);
    expect(timeout.signal.aborted).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('preserves PASS/FAIL results and the exact stdout line', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(Object.isFrozen(PROBE_STATUS)).toBe(true);
    expect(buildSuccess('fixture success')).toEqual({ status: 'PASS', detail: 'fixture success' });
    expect(buildFailure('fixture failure')).toEqual({ status: 'FAIL', detail: 'fixture failure' });
    printProbeResult(buildSuccess('fixture success'));
    printProbeResult(buildFailure('fixture failure'));
    expect(write.mock.calls).toEqual([['[PASS] fixture success\n'], ['[FAIL] fixture failure\n']]);
  });

  it('detects direct execution without running imported probes', () => {
    const entryPath = fileURLToPath(new URL('../scripts/railway-fast-path-probe.js', import.meta.url));
    expect(isDirectExecution(pathToFileURL(entryPath).href, ['node', entryPath])).toBe(true);
    expect(isDirectExecution(import.meta.url, ['node', entryPath])).toBe(false);
    expect(isDirectExecution(import.meta.url, ['node'])).toBe(false);
  });
});

describe.each(['railway-fast-path-probe.js', 'railway-async-job-probe.js'])('%s standalone CLI', (scriptName) => {
  function runFixture(fixture) {
    return spawnSync(process.execPath, [
      '--import', new URL('./fixtures/railway-probe-fetch.mjs', import.meta.url).href,
      fileURLToPath(new URL(`../scripts/${scriptName}`, import.meta.url)),
      '--base-url', 'https://probe.invalid', '--request-timeout-ms', '1',
    ], {
      encoding: 'utf8',
      env: { ...process.env, ARCANOS_PROBE_FIXTURE: fixture },
      timeout: 5_000,
    });
  }

  it('prints one PASS line and exits zero on inline success', () => {
    const result = runFixture('inline');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(/^\[PASS\] [^\n]+\n$/);
  });

  it.each(['malformed', 'queued', 'network', 'timeout', 'unusual-throw'])('preserves exit codes and diagnostics for %s', (fixture) => {
    const result = runFixture(fixture);
    const queuedAsync = fixture === 'queued' && scriptName === 'railway-async-job-probe.js';
    expect(result.status).toBe(queuedAsync ? 0 : 1);
    expect(result.stderr).toBe('');
    expect(result.stdout).toMatch(queuedAsync ? /^\[PASS\] [^\n]+\n$/ : /^\[FAIL\] [^\n]+\n$/);
    if (fixture === 'network') expect(result.stdout).toBe('[FAIL] fixture network failure\n');
    if (fixture === 'timeout') expect(result.stdout).toBe('[FAIL] This operation was aborted\n');
    if (fixture === 'unusual-throw') expect(result.stdout).toBe('[FAIL] fixture thrown string\n');
  });
});
