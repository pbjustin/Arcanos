import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import {
  ArcanosCoreAdvisoryError,
  type ArcanosCoreAdvisoryPort
} from '../platform/operator/arcanosCoreAdvisoryClient.js';

export const ARCANOS_CORE_ADVISORY_TOOL_NAME = 'arcanos_core.consult' as const;

const advisoryInputSchema = z.object({
  task: z.string().trim().min(1).max(8_000),
  context: z.string().trim().max(12_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(4_096).optional().default(2_048)
}).strict();

const GENERIC_ERROR = {
  code: 'ARCANOS_CORE_ADVISORY_FAILED',
  message: 'The advisory consultation could not be completed.'
} as const;

export function createArcanosCoreAdvisoryMcpServer(client: ArcanosCoreAdvisoryPort): McpServer {
  const server = new McpServer(
    { name: 'arcanos-core-advisory', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    ARCANOS_CORE_ADVISORY_TOOL_NAME,
    {
      title: 'Consult ARCANOS Core',
      description: 'Creates one bounded, idempotent advisory job for the fixed arcanos-core backend AI and polls its fixed result endpoint. This operation creates durable remote job state.',
      inputSchema: advisoryInputSchema,
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true
      }
    },
    async (input) => {
      try {
        const result = await client.consult({
          task: input.task,
          ...(input.context ? { context: input.context } : {}),
          maxOutputTokens: input.maxOutputTokens
        });
        const structuredContent = result as unknown as Record<string, unknown>;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          structuredContent
        };
      } catch (error) {
        const publicError = error instanceof ArcanosCoreAdvisoryError
          ? { code: error.code, message: error.message }
          : GENERIC_ERROR;
        const structuredContent = { ok: false, error: publicError };
        return {
          isError: true,
          content: [{ type: 'text' as const, text: JSON.stringify(structuredContent) }],
          structuredContent
        };
      }
    }
  );

  return server;
}
