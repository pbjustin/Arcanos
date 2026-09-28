import { describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createNativePrPreviewApplication } from '../src/nativePrPreviewApplication.js';
import { NATIVE_PR_PREVIEW_E2E_CONTRACT } from '../scripts/native-pr-preview-contract.mjs';
import { runGamingMcpPreviewE2e } from '../scripts/gaming-mcp-preview-e2e.mjs';
import { expectedNativePrPreviewResponseBody } from '../scripts/native-pr-preview-e2e.mjs';
const contract = NATIVE_PR_PREVIEW_E2E_CONTRACT.chatGptGaming;
const migration = NATIVE_PR_PREVIEW_E2E_CONTRACT.pluginMigration;
const identity = { prNumber: 1520, sourceCommit: 'a'.repeat(40) };
const rpc = (method: string, params: unknown = {}) => ({ jsonrpc: '2.0', id: 'gaming-preview', method, params });
const query = rpc('tools/call', { name: 'arcanos_gaming_query', arguments: contract.queryInput });
const app = () => createNativePrPreviewApplication({ identity,
  readinessState: { applicationImported: true, fixturesSealed: true, ready: true, draining: false },
  notionConnectivityProbe: jest.fn(async () => { throw new Error('Unexpected network probe'); }),
});
const noProof = (headers: Record<string, unknown>) => {
  expect(headers[contract.proofHeader]).toBeUndefined(); expect(headers[migration.proofHeader]).toBeUndefined();
};

describe('Gaming MCP sealed HTTP boundary', () => {
  it('supports the actual MCP SDK over a loopback-only transport', async () => {
    const server = createServer(app()).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback listener');
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new Client({ name: 'gaming-sealed-fixture', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(origin + contract.path), {
      fetch: (input, init) => {
        if (new URL(input instanceof Request ? input.url : String(input)).origin !== origin) throw new Error('Unexpected remote request');
        return fetch(input, { ...init, redirect: 'error' });
      },
    });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toHaveLength(8);
      expect((await client.callTool({ name: 'arcanos_gaming_query', arguments: contract.queryInput })).structuredContent).toEqual(contract.queryOutput);
      expect((await client.callTool({ name: 'arcanos_gaming_hybrid_query', arguments: contract.hybridInput })).structuredContent).toEqual(contract.hybridOutput);
      expect((await client.callTool({ name: 'arcanos_gaming_ingest_sources', arguments: { confirmStore: true } })).isError).toBe(true);
    } finally {
      await client.close();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it.each(['authorization', 'cookie', 'mcp-session-id', 'x-api-key'])('denies %s before malformed body parsing', async header => {
    const response = await request(app()).post(contract.path).set(header, 'synthetic-invalid').set('Content-Type', 'application/json').send('{');
    expect(response.status).toBe(404); expect(response.text).toBe('not found'); noProof(response.headers);
  });
  it('only returns success proofs for completed fixed fixtures, with bounded transport', async () => {
    const fixtureApp = app();
    const success = await request(fixtureApp).post(contract.path).send(query);
    expect(success.status).toBe(200);
    expect(success.headers[contract.proofHeader]).toBe(contract.proofVersion);
    expect(success.headers[migration.proofHeader]).toBe(migration.proofVersion);
    for (const body of [rpc('tools/list'), rpc('tools/call', { name: 'modules.invoke', arguments: {} }),
      rpc('tools/call', { name: 'arcanos_gaming_ingest_sources', arguments: { confirmStore: true } })]) {
      const response = await request(fixtureApp).post(contract.path).send(body); noProof(response.headers);
    }
    const over = await request(fixtureApp).post(contract.path).set('Content-Type', 'application/json').send(JSON.stringify(query).padEnd(4_097, ' '));
    expect(over.status).toBe(404); noProof(over.headers);
    const metadata = await request(fixtureApp).get(contract.metadataPath);
    expect(metadata.status).toBe(404); noProof(metadata.headers);
  });
  it('runs the bounded supplemental verifier against real web fixture responses and synthetic passive-worker denials', async () => {
    const fixtureApp = app();
    const args = ['--pr-number', String(identity.prNumber), '--commit-sha', identity.sourceCommit,
      '--web-base-url', 'https://web-pr-1520.up.railway.app', '--worker-base-url', 'https://worker-pr-1520.up.railway.app', '--execute', '--allow-network'];
    const localGitState = { clean: true, head: identity.sourceCommit, repository: 'pbjustin/Arcanos' };
    let requests = 0;
    const fetchImpl = async (input: string, init: RequestInit) => {
      requests += 1;
      const url = new URL(input);
      expect(init.redirect).toBe('error'); expect(init.credentials).toBe('omit');
      if (url.hostname.startsWith('worker-')) return url.pathname === '/readyz'
        ? new Response(JSON.stringify(expectedNativePrPreviewResponseBody({ expectedType: 'worker-readiness' }, { prNumber: identity.prNumber, commitSha: identity.sourceCommit })), { headers: { 'Content-Type': 'application/json' } })
        : new Response('not found', { status: 404 });
      let operation = init.method === 'GET' ? request(fixtureApp).get(url.pathname) : request(fixtureApp).post(url.pathname);
      for (const [key, value] of Object.entries(init.headers ?? {})) operation = operation.set(key, String(value));
      const result = init.body === undefined ? await operation : await operation.send(String(init.body));
      return new Response(result.status === 202 ? null : result.text, { status: result.status, headers: result.headers });
    };
    const result = await runGamingMcpPreviewE2e({ args, localGitState, fetchImpl });
    expect(result.summary).toMatchObject({ status: 'PASS', requestsMade: 21 });
    expect(requests).toBe(21);
    expect(result.checks.filter((check: { gamingMcpCoreVerified?: boolean }) => check.gamingMcpCoreVerified)).toHaveLength(2);
    const dry = await runGamingMcpPreviewE2e({ args: args.slice(0, -2), localGitState, fetchImpl: async () => { throw new Error('Dry-run network'); } });
    expect(dry.executed).toBe(false);
  });
});
