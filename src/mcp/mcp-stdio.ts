import { createMcpServer } from './server.js';
import { buildMcpStdioContext } from './context.js';

/**
 * Local stdio MCP entrypoint (Claude Desktop / Cursor).
 *
 * IMPORTANT: Do not write logs to stdout. Stdio transport uses stdout for protocol messages.
 * If you need debugging, write to stderr.
 */
async function getStdioTransport() {
  const mod = await import('@modelcontextprotocol/sdk/server/stdio.js');
  return (mod as any).StdioServerTransport;
}

function parseSessionIdFromArgs(argv: string[]): string | undefined {
  const idx = argv.findIndex(a => a === '--sessionId' || a === '--session-id');
  if (idx >= 0 && typeof argv[idx + 1] === 'string') return argv[idx + 1];
  // Allow ENV fallback
  return process.env.MCP_SESSION_ID || process.env.ARCANOS_SESSION_ID || undefined;
}

async function main() {
  const sessionId = parseSessionIdFromArgs(process.argv.slice(2));
  const ctx = buildMcpStdioContext(sessionId);

  const server = await createMcpServer(ctx);

  const StdioServerTransport = await getStdioTransport();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  const shutdown = async (signal: string) => {
    try { await transport.close?.(); } catch {}
    try { await server.close?.(); } catch {}
    // eslint-disable-next-line no-process-exit
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  // Stderr only
  // eslint-disable-next-line no-console
  console.error('[mcp-stdio] fatal:', err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
