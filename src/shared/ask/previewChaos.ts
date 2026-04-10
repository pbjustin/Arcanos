import { z } from 'zod';

export const previewAskChaosHookSchema = z.object({
  kind: z.literal('reasoning_timeout_once'),
  hookId: z.string().trim().min(1).max(128),
  delayBeforeCallMs: z.number().int().positive().max(60_000),
  timeoutMs: z.number().int().positive().max(60_000).optional()
});

export type PreviewAskChaosHook = z.infer<typeof previewAskChaosHookSchema>;

export function isRailwayPreviewEnvironment(
  environmentName = process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    process.env.RAILWAY_ENVIRONMENT?.trim() ||
    ''
): boolean {
  return environmentName.startsWith('Arcanos-pr-');
}
