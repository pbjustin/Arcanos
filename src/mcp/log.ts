export type McpLogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface McpLogger {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info: (msg: string, meta?: Record<string, unknown>) => void;
  warn: (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
}

function emit(level: McpLogLevel, msg: string, meta?: Record<string, unknown>) {
  const payload = {
    ts: new Date().toISOString(),
    level,
    msg,
    ...(meta ? { meta } : {}),
  };

  // IMPORTANT for stdio MCP servers: never write logs to stdout.
  // Use stderr for both stdio and HTTP to keep behavior consistent.
  try {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } catch {
    // Last resort: ignore logging failures.
  }
}

export function createMcpLogger(baseMeta?: Record<string, unknown>): McpLogger {
  const withBase = (meta?: Record<string, unknown>) => ({ ...(baseMeta ?? {}), ...(meta ?? {}) });

  return {
    debug: (msg, meta) => emit('debug', msg, withBase(meta)),
    info: (msg, meta) => emit('info', msg, withBase(meta)),
    warn: (msg, meta) => emit('warn', msg, withBase(meta)),
    error: (msg, meta) => emit('error', msg, withBase(meta)),
  };
}
