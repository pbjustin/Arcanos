import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, jest } from '@jest/globals';

import {
  ARCANOS_CORE_ADVISORY_TOOL_NAME,
  createArcanosCoreAdvisoryMcpServer
} from '../src/mcp/arcanosCoreAdvisoryMcp.js';

async function withClient(
  advisoryClient: { consult: (input: unknown) => Promise<unknown> },
  callback: (client: Client) => Promise<void>
): Promise<void> {
  const server = createArcanosCoreAdvisoryMcpServer(advisoryClient as never);
  const client = new Client({ name: 'arcanos-advisory-test', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await callback(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe('arcanos-core advisory MCP bridge', () => {
  it('registers exactly one mutation-aware advisory tool', async () => {
    await withClient({ consult: jest.fn(async () => ({ ok: true })) }, async (client) => {
      const tools = await client.listTools();

      expect(tools.tools).toHaveLength(1);
      expect(tools.tools[0]).toEqual(expect.objectContaining({
        name: ARCANOS_CORE_ADVISORY_TOOL_NAME,
        annotations: expect.objectContaining({
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true
        })
      }));
      expect(tools.tools[0]?.annotations).not.toHaveProperty('readOnlyHint');
    });
  });

  it('returns sanitized structured output from the injected client', async () => {
    const consult = jest.fn(async () => ({
      ok: true,
      gptId: 'arcanos-core',
      jobId: '11111111-1111-4111-8111-111111111111',
      result: { recommendation: 'keep boundaries explicit' }
    }));

    await withClient({ consult }, async (client) => {
      const result = await client.callTool({
        name: ARCANOS_CORE_ADVISORY_TOOL_NAME,
        arguments: { task: 'Review the sanitized architecture.' }
      });

      expect(consult).toHaveBeenCalledWith({
        task: 'Review the sanitized architecture.',
        maxOutputTokens: 2048
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual(expect.objectContaining({
        ok: true,
        gptId: 'arcanos-core'
      }));
    });
  });

  it('rejects caller-supplied host, credential, GPT, and unknown fields', async () => {
    const consult = jest.fn(async () => ({ ok: true }));

    await withClient({ consult }, async (client) => {
      for (const unsafeArguments of [
        { task: 'review', baseUrl: 'https://attacker.example' },
        { task: 'review', token: 'caller-test-placeholder' },
        { task: 'review', gptId: 'default' },
        { task: 'review', endpoint: '/other' }
      ]) {
        const result = await client.callTool({
          name: ARCANOS_CORE_ADVISORY_TOOL_NAME,
          arguments: unsafeArguments
        });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).not.toContain('caller-test-placeholder');
        expect(JSON.stringify(result)).not.toContain('attacker.example');
      }
    });

    expect(consult).not.toHaveBeenCalled();
  });

  it('returns only a stable public error when the advisory client fails', async () => {
    const sentinel = 'secret-sentinel-mcp';
    await withClient({
      consult: jest.fn(async () => {
        throw new Error(`provider path C:\\private\\runtime leaked ${sentinel}`);
      })
    }, async (client) => {
      const result = await client.callTool({
        name: ARCANOS_CORE_ADVISORY_TOOL_NAME,
        arguments: { task: 'Review sanitized findings.' }
      });
      const serialized = JSON.stringify(result);

      expect(result).toEqual(expect.objectContaining({
        isError: true,
        structuredContent: {
          ok: false,
          error: {
            code: 'ARCANOS_CORE_ADVISORY_FAILED',
            message: 'The advisory consultation could not be completed.'
          }
        }
      }));
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain('C:\\private');
    });
  });

  it('keeps the standalone entrypoint independent from the broad MCP context and application server', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const sources = [
      'src/mcp/arcanos-core-advisory-stdio.ts',
      'src/mcp/arcanosCoreAdvisoryMcp.ts',
      'src/platform/operator/arcanosCoreAdvisoryClient.ts'
    ].map((filePath) => fs.readFileSync(path.resolve(filePath), 'utf8')).join('\n');

    await import('../src/mcp/arcanos-core-advisory-stdio.js');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sources).not.toContain("./server.js");
    expect(sources).not.toContain("./context.js");
    expect(sources).not.toContain("from 'openai'");
    expect(sources).not.toContain('start-server');
  });
});
