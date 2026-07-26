export type PromptDebugTraceContentMode = 'off' | 'metadata' | 'full';

export const PROMPT_DEBUG_TRACE_MODE_ENV = 'PROMPT_DEBUG_TRACE_MODE';

export function resolvePromptDebugTraceMode(
  environment: NodeJS.ProcessEnv = process.env,
): PromptDebugTraceContentMode {
  const configured = environment[PROMPT_DEBUG_TRACE_MODE_ENV];
  if (configured === undefined || configured.trim().length === 0) {
    return 'metadata';
  }

  if (configured === 'off' || configured === 'metadata' || configured === 'full') {
    return configured;
  }

  return 'off';
}
