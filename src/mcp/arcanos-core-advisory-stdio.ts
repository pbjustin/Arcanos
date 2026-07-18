import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import {
  createArcanosCoreAdvisoryClient,
  resolveArcanosCoreAdvisoryConfig
} from '../platform/operator/arcanosCoreAdvisoryClient.js';
import { createArcanosCoreAdvisoryMcpServer } from './arcanosCoreAdvisoryMcp.js';

export async function runArcanosCoreAdvisoryStdio(): Promise<void> {
  const config = resolveArcanosCoreAdvisoryConfig();
  const client = createArcanosCoreAdvisoryClient(config);
  const server = createArcanosCoreAdvisoryMcpServer(client);
  const transport = new StdioServerTransport();

  const shutdown = async (): Promise<void> => {
    await server.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
  };

  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());
  await server.connect(transport);
}

function isDirectExecution(): boolean {
  const scriptPath = process.argv[1];
  return typeof scriptPath === 'string' &&
    import.meta.url === pathToFileURL(path.resolve(scriptPath)).href;
}

if (isDirectExecution()) {
  runArcanosCoreAdvisoryStdio().catch(() => {
    process.stderr.write('[arcanos-core-advisory] startup failed.\n');
    process.exitCode = 1;
  });
}
