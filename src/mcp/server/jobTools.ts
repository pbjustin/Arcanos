import { z } from 'zod';

import type { McpRequestContext } from '../context.js';
import { mcpError, mcpText } from '../errors.js';
import { getJobById } from '@core/db/repositories/jobRepository.js';
import {
  buildGptJobResultBridgePayload,
  buildGptJobStatusBridgePayload,
} from '@shared/gpt/gptJobResult.js';
import { wrapTool } from './helpers.js';

type AnyMcpServer = {
  registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) => void;
};

export function registerJobMcpTools(server: AnyMcpServer, ctx: McpRequestContext): void {
  server.registerTool(
    'jobs.status',
    {
      title: 'Job Status',
      description: 'Control plane: reads async GPT job status without entering Trinity or write dispatch.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jobId: z.string().trim().min(1),
      }),
    },
    wrapTool('jobs.status', ctx, async (args: any) => {
      const job = await getJobById(args.jobId);
      if (!job) {
        return mcpError({
          code: 'ERR_NOT_FOUND',
          message: 'Async GPT job was not found.',
          details: { action: 'get_status', jobId: args.jobId },
          requestId: ctx.requestId,
        });
      }

      return mcpText({
        ok: true,
        ...buildGptJobStatusBridgePayload(job),
      });
    })
  );

  server.registerTool(
    'jobs.result',
    {
      title: 'Job Result',
      description: 'Control plane: reads async GPT job results without entering Trinity or write dispatch.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        jobId: z.string().trim().min(1),
      }),
    },
    wrapTool('jobs.result', ctx, async (args: any) => {
      const job = await getJobById(args.jobId);
      if (!job) {
        return mcpError({
          code: 'ERR_NOT_FOUND',
          message: 'Async GPT job was not found.',
          details: { action: 'get_result', jobId: args.jobId },
          requestId: ctx.requestId,
        });
      }

      return mcpText({
        ok: true,
        ...buildGptJobResultBridgePayload(args.jobId, job),
      });
    })
  );
}
