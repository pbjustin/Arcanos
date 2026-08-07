import { config } from '@platform/runtime/config.js';
import {
  createMcpHttpBodyParser,
  resolveConfiguredMcpHttpBodyLimitBytes,
} from './httpBodyParserCore.js';

export { MCP_HTTP_BODY_LIMIT_BYTES } from './httpBodyParserCore.js';

/**
 * Resolve the effective MCP body limit. MCP_HTTP_BODY_LIMIT is downward-only,
 * and a stricter broad JSON_LIMIT remains authoritative for this route.
 */
export function resolveMcpHttpBodyLimitBytes(
  rawValue: string | undefined = process.env.MCP_HTTP_BODY_LIMIT,
  globalJsonLimit: string = config.limits.jsonLimit
): number {
  return resolveConfiguredMcpHttpBodyLimitBytes(rawValue, globalJsonLimit);
}

/**
 * Parse an exact MCP HTTP POST before the application's broad JSON parser.
 * Reuse is intentional: the application and standalone router both mount this
 * middleware, while the request marker guarantees one bounded read.
 */
export const mcpHttpBodyParser = createMcpHttpBodyParser(
  resolveMcpHttpBodyLimitBytes()
);
