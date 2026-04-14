import { describe, expect, it } from '@jest/globals';

describe('MCP HTTP transport runtime dependencies', () => {
  it('loads the packaged SDK HTTP transport and hono node adapter', async () => {
    await expect(import('@modelcontextprotocol/sdk/server/streamableHttp.js')).resolves.toBeDefined();
    await expect(import('@hono/node-server')).resolves.toBeDefined();
  });
});
