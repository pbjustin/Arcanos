import { afterEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { createNativePrPreviewApplication } from '../src/nativePrPreviewApplication.js';
import { runBookerMcpPreviewE2e } from '../scripts/booker-mcp-preview-e2e.mjs';
import { expectedNativePrPreviewResponseBody } from '../scripts/native-pr-preview-e2e.mjs';

const commitSha = 'a'.repeat(40);
const web = 'https://arcanos-v2-pr-676861-1566.up.railway.app';
const worker = 'https://arcanos-worker-pr-676861-1566.up.railway.app';
const args = ['--pr-number', '1566', '--commit-sha', commitSha, '--web-base-url', web,
  '--worker-base-url', worker, '--total-timeout-ms', '120000'];
const localGitState = { clean: true, head: commitSha, repository: 'pbjustin/Arcanos' };
afterEach(() => jest.restoreAllMocks());

function fixtureFetch(mutate?: (path: string, body: Record<string, any>) => void): typeof fetch {
  const app = createNativePrPreviewApplication({ identity: { prNumber: 1566, sourceCommit: commitSha }, bookerOrigin: web,
    readinessState: { applicationImported: true, fixturesSealed: true, ready: true, draining: false },
    notionConnectivityProbe: async () => { throw new Error('Unexpected Notion call'); } });
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== web && url.origin !== worker) throw new Error('Unexpected external target');
    expect(init?.redirect).toBe('error'); expect(init?.credentials).toBe('omit');
    if (url.origin === worker) return url.pathname === '/readyz'
      ? new Response(JSON.stringify(expectedNativePrPreviewResponseBody({ expectedType: 'worker-readiness' }, { prNumber: 1566, commitSha })), { status: 200 })
      : new Response('not found', { status: 404 });
    let operation = init?.method === 'GET' ? request(app).get(url.pathname) : request(app).post(url.pathname);
    for (const [name, value] of new Headers(init?.headers)) operation = operation.set(name, value);
    if (init?.body !== undefined) operation = operation.send(String(init.body));
    const response = await operation;
    const body = response.body as Record<string, any>;
    mutate?.(url.pathname, body);
    return new Response(response.status === 202 ? null : response.headers['content-type']?.includes('application/json') ? JSON.stringify(body) : response.text, { status: response.status,
      headers: Object.fromEntries(Object.entries(response.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) });
  }) as typeof fetch;
}

describe('bounded Booker deployed verifier', () => {
  it('validates exact-head targets without signing or network in dry run', async () => {
    const fetchImpl = jest.fn<typeof fetch>();
    expect((await runBookerMcpPreviewE2e({ args, localGitState, fetchImpl })).summary.status).toBe('PASS');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(runBookerMcpPreviewE2e({ args, localGitState: { ...localGitState, clean: false }, fetchImpl })).rejects.toThrow('LOCAL_WORKTREE_DIRTY');
    await expect(runBookerMcpPreviewE2e({ args: args.map(value => value === '1566' ? '1567' : value), localGitState, fetchImpl })).rejects.toThrow();
  });
  it('executes the whole matrix through the actual synthetic application with bounded limiter rollover', async () => {
    const realNow = Date.now.bind(Date); let offset = 0;
    jest.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const waitImpl = jest.fn(async (ms: number) => { expect(ms).toBeLessThanOrEqual(30_000); offset += ms; });
    const receipt = await runBookerMcpPreviewE2e({ args: [...args, '--execute', '--allow-network'], localGitState,
      fetchImpl: fixtureFetch(), waitImpl });
    expect(receipt.summary.status).toBe('PASS'); expect(receipt.checks.length).toBeGreaterThan(50);
    expect(waitImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(receipt)).not.toContain('Bearer ');
    expect(receipt.effectEvidence).toMatchObject({ totalJobs: 3, terminalJobs: 3, pendingJobs: 0, canonWrites: 0, providerRequests: 0 });
  }, 30_000);
  it.each(['metadata', 'catalog', 'schema', 'read-permission'])('rejects drift in %s before accepting later fixtures', async kind => {
    const fetchImpl = fixtureFetch((path, body) => {
      if (kind === 'metadata' && path.startsWith('/.well-known/')) body.resource = 'https://wrong.invalid/chatgpt/booker/mcp';
      if (kind === 'catalog' && body.result?.tools) body.result.tools.pop();
      if (kind === 'schema' && body.result?.tools) body.result.tools[0].inputSchema.additionalProperties = true;
      if (kind === 'read-permission' && body.result?.content?.[0]?.text === 'BOOKER_PERMISSION_DENIED') body.result.isError = false;
    });
    await expect(runBookerMcpPreviewE2e({ args: [...args, '--execute', '--allow-network'], localGitState, fetchImpl }))
      .rejects.toThrow('BOOKER_PREVIEW_');
  });
});
