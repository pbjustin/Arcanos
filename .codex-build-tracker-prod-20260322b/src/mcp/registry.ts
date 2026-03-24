/**
 * MCP toggles for safer deployments.
 *
 * - MCP_EXPOSE_DESTRUCTIVE: set 'true' to expose destructive tools (execute/block/expire/delete)
 * - MCP_REQUIRE_CONFIRMATION: set 'true' to require a server-issued confirmation nonce for gated tools
 * - MCP_ENABLE_SESSIONS: set 'true' to enable MCP transport session IDs (HTTP). Useful for per-session throttles.
 * - MCP_ALLOW_MODULE_ACTIONS: CSV allowlist for modules.invoke, e.g. "rag:*,billing:charge"
 *
 * Public defaults are conservative.
 */
export const MCP_FLAGS = {
  exposeDestructive: (process.env.MCP_EXPOSE_DESTRUCTIVE ?? 'false') === 'true',
  requireConfirmation: (process.env.MCP_REQUIRE_CONFIRMATION ?? 'true') === 'true',
  enableSessions: (process.env.MCP_ENABLE_SESSIONS ?? 'false') === 'true',
} as const;

export type McpToolExposure = 'default' | 'gated' | 'destructive';

export interface McpToolSpec {
  name: string;
  exposure: McpToolExposure;
}
