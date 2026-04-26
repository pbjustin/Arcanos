import { z } from 'zod';

import type { ControlPlaneRequest } from './types.js';

export const CONTROL_PLANE_PROVIDER_VALUES = [
  'railway-cli',
  'arcanos-cli',
  'arcanos-mcp',
  'backend-api',
  'local-command',
  'codex-ide',
] as const;

const scalarTargetValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

export const controlPlaneTargetSchema = z
  .object({
    resource: z.string().trim().min(1).max(160),
    id: z.string().trim().min(1).max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    service: z.string().trim().min(1).max(200).optional(),
  })
  .catchall(scalarTargetValueSchema);

export const controlPlaneInvokeRequestSchema = z.object({
  operation: z.string().trim().min(1).max(120),
  provider: z.enum(CONTROL_PLANE_PROVIDER_VALUES),
  target: controlPlaneTargetSchema,
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

export function parseControlPlaneRequest(candidate: unknown): ControlPlaneRequest {
  return controlPlaneInvokeRequestSchema.parse(candidate) as ControlPlaneRequest;
}

export function safeParseControlPlaneRequest(candidate: unknown) {
  return controlPlaneInvokeRequestSchema.safeParse(candidate);
}
