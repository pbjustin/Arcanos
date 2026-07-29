import { describe, expect, it } from '@jest/globals';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import request from 'supertest';

describe('MCP HTTP transport runtime dependencies', () => {
  it('loads the packaged SDK HTTP transport entrypoint', async () => {
    await expect(import('@modelcontextprotocol/sdk/server/streamableHttp.js')).resolves.toBeDefined();
  });

  it('constructs and closes the Node HTTP transport adapter', async () => {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      keepAliveMs: 0,
    });

    await expect(transport.start()).resolves.toBeUndefined();
    await expect(transport.close()).resolves.toBeUndefined();
  });

  it('round-trips an initialize request through the Node HTTP adapter', async () => {
    const { StreamableHTTPServerTransport } = await import(
      '@modelcontextprotocol/sdk/server/streamableHttp.js'
    );
    const initializeRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'arcanos-http-transport-test-client',
          version: '1.0.0',
        },
      },
    } as const;
    const mcpServer = new McpServer({
      name: 'arcanos-http-transport-regression',
      version: '1.0.0',
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      keepAliveMs: 0,
    });
    const app = express();
    app.use(express.json());
    app.post('/mcp', async (req, res, next) => {
      try {
        await transport.handleRequest(req, res, req.body);
      } catch (error) {
        next(error);
      }
    });

    try {
      await mcpServer.connect(transport);

      const response = await request(app)
        .post('/mcp')
        .set('Accept', 'application/json, text/event-stream')
        .set('Content-Type', 'application/json')
        .send(initializeRequest)
        .expect(200)
        .expect('Content-Type', /text\/event-stream/);

      expect(response.headers['mcp-session-id']).toBeUndefined();
      expect(response.text).toContain('event: message');

      const dataLine = response.text
        .split(/\r?\n/)
        .find(line => line.startsWith('data: '));
      expect(dataLine).toBeDefined();
      if (!dataLine) {
        throw new Error('MCP initialize response omitted its SSE data frame');
      }

      const message = JSON.parse(dataLine.slice('data: '.length));
      expect(message).toMatchObject({
        jsonrpc: '2.0',
        id: 1,
        result: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          serverInfo: {
            name: 'arcanos-http-transport-regression',
            version: '1.0.0',
          },
        },
      });
    } finally {
      await mcpServer.close();
    }
  });
});
