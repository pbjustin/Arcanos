import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {
  buildRepositoryRequest, validateRepositoryRequest, runRepositoryRegistration,
} from '../scripts/register-repository.mjs';

const root = process.cwd();
const input = JSON.parse(readFileSync(path.join(root, 'tests/fixtures/repository-registration/input.json'), 'utf8'));
const response = (status, body) => ({ status, text: async () => body });
const mockBaseUrl = 'http://127.0.0.1:12345';

afterEach(() => { jest.useRealTimers(); });

describe('repository registration serialization and contract boundary', () => {
  it('reproduces the original jq compile failure with the recorded workflow input', () => {
    const filter = readFileSync(path.join(root, 'tests/fixtures/repository-registration/original-jq-filter.txt'), 'utf8');
    const payload = buildRepositoryRequest(input).metadata;
    const failed = spawnSync(process.env.JQ_BINARY || 'jq', [
      '-nc', '--arg', 'prompt', `Register repository features and persist the attached metadata for later retrieval. Payload: ${JSON.stringify(payload)}`,
      '--argjson', 'metadata', JSON.stringify(payload), filter,
    ], { encoding: 'utf8' });
    expect(failed.error).toBeUndefined();
    expect(failed.status).not.toBe(0);
    expect(failed.stderr).toContain('compile error');
    expect(failed.stdout).toBe('');
  });

  it('constructs valid JSON with all original metadata fields and no persistence request', () => {
    const body = JSON.parse(JSON.stringify(buildRepositoryRequest(input)));
    expect(body).toEqual({ action: 'query', prompt: 'Describe the repository features supplied in metadata.', metadata: {
      repo_name: input.repoName, commit_hash: input.commitHash, detected_features: input.features,
      languages: input.languages, branch: input.branch, timestamp: input.timestamp,
      event_type: 'repository_registration', github_repository: input.githubRepository,
    } });
    expect(validateRepositoryRequest(body)).toEqual(body);
    expect(body).not.toHaveProperty('sessionId');
  });

  it.each([undefined, '', '{}', {}, { javascript: 0 }])('supports empty or missing features: %j', (features) => {
    const body = buildRepositoryRequest({ ...input, features, languages: '' });
    expect(body.metadata.detected_features).toEqual({});
    expect(body.metadata.languages).toBe('');
  });

  it('preserves quotes, newlines, shell syntax and Unicode as data', () => {
    const unusual = 'a"\\\n$(touch NEVER) `${secret}` 🚀';
    const body = buildRepositoryRequest({ ...input, repoName: unusual, branch: unusual, githubRepository: unusual });
    const roundTrip = JSON.parse(JSON.stringify(body));
    expect(roundTrip.metadata.repo_name).toBe(unusual);
    expect(roundTrip.metadata.branch).toBe(unusual);
    expect(roundTrip.metadata.github_repository).toBe(unusual);
    expect(roundTrip.prompt).not.toContain(unusual);
  });

  it.each(['{broken', '[]', 'null', '{"javascript":-1}', '{"javascript":"1"}', '{"javascript":1.5}', '{"__proto__":1}', '{"unknown":1}'])('rejects malformed feature input before any request: %s', async (features) => {
    const fetchFn = jest.fn();
    const result = await runRepositoryRegistration({ ...input, features }, { mockBaseUrl, fetchFn });
    expect(result.requestStatus).toBe('payload_invalid');
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { languages: 'go' }, { commitHash: '' }, { commitHash: 'not-a-sha' },
    { repoName: null }, { branch: '' }, { timestamp: 'invalid' },
  ])('rejects inconsistent identity or metadata: %j', (change) => {
    expect(() => buildRepositoryRequest({ ...input, ...change })).toThrow();
  });

  it.each([
    (body) => ({ ...body, action: 'save' }),
    (body) => ({ ...body, sessionId: 'unexpected' }),
    (body) => ({ ...body, prompt: '' }),
    (body) => ({ ...body, metadata: { ...body.metadata, token: 'secret' } }),
    (body) => ({ ...body, metadata: { ...body.metadata, event_type: 'different' } }),
  ])('rejects an invalid request envelope', (change) => {
    expect(() => validateRepositoryRequest(change(buildRepositoryRequest(input)))).toThrow();
  });

  it('never sends the production workflow candidate without a registration contract', async () => {
    const fetchFn = jest.fn();
    expect(await runRepositoryRegistration(input, { fetchFn })).toEqual({
      schemaVersion: 1, reportingStatus: 'completed', registrationStatus: 'unsupported',
      registrationSucceeded: false, requestStatus: 'not_sent_contract_unsupported', httpStatus: null,
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    'https://acranos-production.up.railway.app', 'http://example.com:80',
    'http://localhost:1234', 'http://127.0.0.1:1234/path', 'http://user:secret@127.0.0.1:1234',
    'http://127.0.0.1:1234?token=secret', 'https://127.0.0.1:1234',
  ])('rejects non-mock destinations without calling transport: %s', async (url) => {
    const fetchFn = jest.fn();
    expect((await runRepositoryRegistration(input, { mockBaseUrl: url, fetchFn })).requestStatus).toBe('mock_target_rejected');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe('single-attempt loopback verification and safe reporting', () => {
  it.each([200, 201, 202])('never interprets HTTP %i/model registration claims as durable success', async (status) => {
    const fetchFn = jest.fn(async () => response(status, JSON.stringify({ ok: true, registered: true, result: 'Successfully registered! secret-value' })));
    const result = await runRepositoryRegistration(input, { mockBaseUrl, fetchFn });
    expect(result).toMatchObject({ requestStatus: 'mock_query_accepted', registrationStatus: 'unsupported', registrationSucceeded: false, httpStatus: status });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain('secret-value');
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toBe(`${mockBaseUrl}/gpt/arcanos-daemon`);
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(Object.keys(init.headers).sort()).toEqual(['Content-Type', 'User-Agent']);
    expect(validateRepositoryRequest(JSON.parse(init.body))).toEqual(buildRepositoryRequest(input));
  });

  it.each([400, 401, 403, 500, 503, 302])('reports HTTP %i without reading or exposing the response and without retries', async (status) => {
    const text = jest.fn(async () => 'Bearer <synthetic-test-token>');
    const fetchFn = jest.fn(async () => ({ status, text }));
    expect(await runRepositoryRegistration(input, { mockBaseUrl, fetchFn })).toMatchObject({ requestStatus: 'http_error', httpStatus: status, registrationSucceeded: false });
    expect(text).not.toHaveBeenCalled();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, {}])('handles a missing backend response: %j', async (missing) => {
    const fetchFn = jest.fn(async () => missing);
    expect((await runRepositoryRegistration(input, { mockBaseUrl, fetchFn })).requestStatus).toBe('missing_response');
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(['', '{malformed', 'x'.repeat(65537)])('rejects missing, malformed or excessive response bodies', async (body) => {
    const result = await runRepositoryRegistration(input, { mockBaseUrl, fetchFn: async () => response(200, body) });
    expect(result.requestStatus).toBe('invalid_response');
  });

  it.each(['null', '[]', '{"ok":false}', '{"ok":"true"}', '{"registered":true}'])('requires actual query acceptance: %s', async (body) => {
    expect((await runRepositoryRegistration(input, { mockBaseUrl, fetchFn: async () => response(200, body) })).requestStatus).toBe('backend_rejected');
  });

  it('does not expose sensitive exception text or retry a network failure', async () => {
    const fetchFn = jest.fn(async () => { throw new Error('https://user:password@example.com Bearer secret-token'); });
    const result = await runRepositoryRegistration(input, { mockBaseUrl, fetchFn });
    expect(result.requestStatus).toBe('network_error');
    expect(JSON.stringify(result)).not.toMatch(/password|Bearer|secret-token/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it.each(['headers', 'body'])('bounds a stalled %s phase, aborts and never retries', async (phase) => {
    jest.useFakeTimers();
    const fetchFn = jest.fn(async () => phase === 'headers'
      ? new Promise(() => {}) : { status: 200, text: () => new Promise(() => {}) });
    const pending = runRepositoryRegistration(input, { mockBaseUrl, fetchFn, timeoutMs: 25 });
    await jest.advanceTimersByTimeAsync(25);
    expect((await pending).requestStatus).toBe('timeout');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn.mock.calls[0][1].signal.aborted).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('executes exactly one real local HTTP request, with no duplicate writes', async () => {
    const received = [];
    const server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      received.push({ url: req.url, method: req.method, body: JSON.parse(raw) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: 'local fixture only' }));
    });
    await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const result = await runRepositoryRegistration(input, { mockBaseUrl: `http://127.0.0.1:${server.address().port}` });
      expect(result.requestStatus).toBe('mock_query_accepted');
      expect(received).toEqual([{ url: '/gpt/arcanos-daemon', method: 'POST', body: buildRepositoryRequest(input) }]);
      expect(result.registrationSucceeded).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise((resolveClose) => server.close(resolveClose));
    }
  });

  it('runs the workflow CLI offline and emits only safe status artifacts', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'arcanos-registration-'));
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts/register-repository.mjs')], {
        cwd: dir, encoding: 'utf8', env: {
          PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
          GITHUB_SHA: input.commitHash, GITHUB_REPOSITORY: input.githubRepository,
          GITHUB_REF_NAME: 'branch-secret-value', REGISTRATION_REPO_NAME: input.repoName,
          REGISTRATION_FEATURES: JSON.stringify(input.features), REGISTRATION_LANGUAGES: input.languages,
          GITHUB_OUTPUT: path.join(dir, 'output'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary'),
        },
      });
      expect(result.status).toBe(0);
      const artifact = readFileSync(path.join(dir, 'repository-registration-status.json'), 'utf8');
      expect(JSON.parse(artifact)).toMatchObject({ registrationSucceeded: false, requestStatus: 'not_sent_contract_unsupported' });
      expect(result.stdout + result.stderr + artifact).not.toContain('branch-secret-value');
      expect(readFileSync(path.join(dir, 'summary'), 'utf8')).toContain('unsupported (not successful)');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps workflow inputs out of shell source and uploads no raw response artifact', () => {
    const workflow = yaml.load(readFileSync(path.join(root, '.github/workflows/register.yml'), 'utf8'));
    const step = workflow.jobs['register-features'].steps.find((candidate) => candidate.id === 'registration');
    expect(step.run).toBe('node scripts/register-repository.mjs');
    expect(Object.keys(step.env).sort()).toEqual(['REGISTRATION_FEATURES', 'REGISTRATION_LANGUAGES', 'REGISTRATION_REPO_NAME']);
    expect(workflow.jobs['register-features'].steps.at(-1).with.path).toBe('repository-registration-status.json');
    expect(JSON.stringify(workflow)).not.toMatch(/curl|response\.json|successfully registered|--mock-base-url/);
    expect(workflow.on).toEqual({ push: { branches: ['main', 'master'] } });
  });
});
