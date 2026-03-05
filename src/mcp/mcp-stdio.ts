import util from 'node:util';

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

/**
 * Redirect console output to stderr for stdio transport safety.
 *
 * Purpose: prevent protocol corruption by keeping stdout reserved for MCP frames.
 * Inputs/outputs: no inputs; mutates console log methods to write to stderr.
 * Edge cases: falls back to a minimal error line when formatting fails.
 */
function redirectConsoleLogsToStderr(): void {
  const writeToStderr = (...args: unknown[]): void => {
    try {
      process.stderr.write(`${util.format(...args)}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[mcp-stdio] failed to forward console output: ${message}\n`);
    }
  };

  console.log = writeToStderr as typeof console.log;
  console.info = writeToStderr as typeof console.info;
  console.warn = writeToStderr as typeof console.warn;
  console.debug = writeToStderr as typeof console.debug;
}

/**
 * Load MCP stdio dependencies after stdout guards are installed.
 *
 * Purpose: ensure import-time logging cannot leak to stdout in stdio mode.
 * Inputs/outputs: no inputs; returns MCP server/context factory functions.
 * Edge cases: import failures propagate to main error handler.
 */
async function loadStdioServerModules(): Promise<{
  createMcpServer: typeof import('./server.js')['createMcpServer'];
  buildMcpStdioContext: typeof import('./context.js')['buildMcpStdioContext'];
}> {
  const [serverModule, contextModule] = await Promise.all([
    import('./server.js'),
    import('./context.js')
  ]);

  return {
    createMcpServer: serverModule.createMcpServer,
    buildMcpStdioContext: contextModule.buildMcpStdioContext
  };
}

function parseSessionIdFromArgs(argv: string[]): string | undefined {
  const idx = argv.findIndex(a => a === '--sessionId' || a === '--session-id');
  if (idx >= 0 && typeof argv[idx + 1] === 'string') return argv[idx + 1];
  // Allow ENV fallback
  return process.env.MCP_SESSION_ID || process.env.ARCANOS_SESSION_ID || undefined;
}

async function main() {
  redirectConsoleLogsToStderr();

  const { createMcpServer, buildMcpStdioContext } = await loadStdioServerModules();

  const sessionId = parseSessionIdFromArgs(process.argv.slice(2));
  const ctx = buildMcpStdioContext(sessionId);

  const server = await createMcpServer(ctx);

  const StdioServerTransport = await getStdioTransport();
  const transport = new StdioServerTransport();

  await server.connect(transport);

  const shutdown = async (signal: string) => {
    try { await transport.close?.(); } catch (error) { console.error('[mcp-stdio] error closing transport:', error); }
    try { await server.close?.(); } catch (error) { console.error('[mcp-stdio] error closing server:', error); }
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
