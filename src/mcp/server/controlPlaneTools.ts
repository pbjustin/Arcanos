import { z } from 'zod';

import type { McpRequestContext } from '../context.js';
import { mcpText } from '../errors.js';
import { wrapTool } from './helpers.js';
import { executeControlPlaneOperation } from '@services/controlPlane/index.js';
import { CONTROL_PLANE_PROVIDER_VALUES } from '@services/controlPlane/schema.js';

type AnyMcpServer = {
  registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) => void;
};

const controlPlaneInvokeInputSchema = z.object({
  operation: z.string().trim().min(1).max(120),
  provider: z.enum(CONTROL_PLANE_PROVIDER_VALUES),
  target: z
    .object({
      resource: z.string().trim().min(1).max(160),
      id: z.string().trim().min(1).max(200).optional(),
      name: z.string().trim().min(1).max(200).optional(),
      service: z.string().trim().min(1).max(200).optional(),
    })
    .catchall(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  environment: z.string().trim().min(1).max(120),
  scope: z.union([
    z.string().trim().min(1).max(120),
    z.array(z.string().trim().min(1).max(120)).min(1).max(20),
  ]),
  params: z.record(z.unknown()),
  approvalToken: z.string().trim().min(1).max(512).optional(),
  dryRun: z.boolean().default(true),
  traceId: z.string().trim().min(1).max(200),
  requestedBy: z.string().trim().min(1).max(200),
});

export function registerControlPlaneMcpTools(server: AnyMcpServer, ctx: McpRequestContext): void {
  server.registerTool(
    'control_plane.invoke',
    {
      title: 'Control Plane Invoke',
      description: 'Runs an allowlisted ARCANOS control-plane operation with schema validation, scope checks, audit logging, approval gates, and redacted output.',
      annotations: { readOnlyHint: false },
      inputSchema: controlPlaneInvokeInputSchema,
    },
    wrapTool('control_plane.invoke', ctx, async (rawArgs: unknown) => {
      const args = controlPlaneInvokeInputSchema.parse(rawArgs);
      const response = await executeControlPlaneOperation(args, { request: ctx.req });
      return mcpText(response);
    })
  );
}
