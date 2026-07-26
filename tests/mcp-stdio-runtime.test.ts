import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from '@jest/globals';

describe('MCP stdio runtime composition', () => {
  it('binds ARCANOS core runtime providers before creating or connecting the server', () => {
    const source = fs.readFileSync(path.resolve('src/mcp/mcp-stdio.ts'), 'utf8');
    const mainIndex = source.indexOf('async function main()');
    const providerIndex = source.indexOf(
      'configureDefaultArcanosCoreRuntimeProviders();',
      mainIndex
    );
    const contextIndex = source.indexOf(
      'const ctx = buildMcpStdioContext(',
      providerIndex
    );
    const serverIndex = source.indexOf(
      'const server = await createMcpServer(ctx);',
      contextIndex
    );
    const connectIndex = source.indexOf(
      'await server.connect(transport);',
      serverIndex
    );

    expect([
      mainIndex,
      providerIndex,
      contextIndex,
      serverIndex,
      connectIndex
    ]).not.toContain(-1);
    expect(mainIndex).toBeLessThan(providerIndex);
    expect(providerIndex).toBeLessThan(contextIndex);
    expect(contextIndex).toBeLessThan(serverIndex);
    expect(serverIndex).toBeLessThan(connectIndex);
  });
});
