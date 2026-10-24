import { z } from 'zod';
import { legacyInteger } from '@shared/validation/zodNumberChecks.js';
import { utf16MaxLength } from '@shared/validation/zodStringChecks.js';

export const previewAskChaosHookSchema = z.object({
  kind: z.literal('reasoning_timeout_once'),
  hookId: z.string().trim().min(1).max(128).check(utf16MaxLength(128)),
  delayBeforeCallMs: z.number().check(...legacyInteger()).positive().max(60_000),
  timeoutMs: z.number().check(...legacyInteger()).positive().max(60_000).optional()
});

export type PreviewAskChaosHook = z.infer<typeof previewAskChaosHookSchema>;

export function isRailwayPreviewEnvironment(
  environmentName = process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    process.env.RAILWAY_ENVIRONMENT?.trim() ||
    ''
): boolean {
  return environmentName.startsWith('Arcanos-pr-');
}
