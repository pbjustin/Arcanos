export type SupportedMode = 'write' | 'sim' | 'audit' | 'build';

const VALID_MODES: Set<SupportedMode> = new Set(['write', 'sim', 'audit', 'build']);

/**
 * Log which handler was selected for debugging.
 */
function logHandlerTrace(mode: SupportedMode): void {
  if (process.env.NODE_ENV === 'development') {
    console.log(`[TRACE] dispatching to '${mode}' handler`);
  }
}

interface DispatchOptions {
  mode?: string;
  [key: string]: any;
}

/**
 * Validate the provided mode and route to the correct handler.
 * Falls back to 'write' if an unsupported mode is supplied.
 */
export function dispatchOpenAIRequest({ mode = 'write', ...rest }: DispatchOptions) {
  if (!VALID_MODES.has(mode as SupportedMode)) {
    console.warn(`Unsupported mode '${mode}', defaulting to 'write'`);
    mode = 'write';
  }

  logHandlerTrace(mode as SupportedMode);

  return routeToCorrectHandler(mode as SupportedMode, rest);
}

/** Placeholder routing implementation */
function routeToCorrectHandler(mode: SupportedMode, rest: any) {
  // In the real system this would call the specific handler for each mode.
  // For now we just return a descriptive object for testing.
  return { mode, args: rest };
}
