import type { McpRequestContext } from '../context.js';
import { mcpText } from '../errors.js';
import { wrapTool } from './helpers.js';
import {
  controlPlaneInvokeRequestSchema,
  executeControlPlaneOperation,
} from '@services/controlPlane/index.js';

type AnyMcpServer = {
  registerTool: (name: string, config: Record<string, unknown>, handler: (args: unknown) => Promise<unknown>) => void;
};

const controlPlaneInvokeInputSchema = controlPlaneInvokeRequestSchema;

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
