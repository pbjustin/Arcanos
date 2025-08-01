export type SupportedMode = 'write' | 'sim' | 'audit' | 'codegen';

const VALID_MODES: Set<SupportedMode> = new Set([
  'write',
  'sim',
  'audit',
  'codegen'
]);

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
  payload?: any;
  [key: string]: any;
}

/**
 * Validate the provided mode and route to the correct handler.
 * Falls back to 'write' if an unsupported mode is supplied.
 */
export function dispatchOpenAIRequest({ mode = 'write', payload }: DispatchOptions) {
  if (!VALID_MODES.has(mode as SupportedMode)) {
    console.warn(`Unsupported mode '${mode}', defaulting to 'write'`);
    mode = 'write';
  }

  logHandlerTrace(mode as SupportedMode);

  return routeToCorrectHandler(mode as SupportedMode, payload);
}

/** Placeholder routing implementation */
type ModeHandler = (payload: any) => any;

function runWriteHandler(payload: any) {
  // Placeholder implementation for write mode
  return { handler: 'write', payload };
}

function runSimulationHandler(payload: any) {
  // Placeholder implementation for simulation mode
  return { handler: 'sim', payload };
}

function runAuditHandler(payload: any) {
  // Placeholder implementation for audit mode
  return { handler: 'audit', payload };
}

function runCodegenHandler(payload: any) {
  // Placeholder implementation for code generation mode
  return { handler: 'codegen', payload };
}

const handlerMap: Record<SupportedMode, ModeHandler> = {
  write: runWriteHandler,
  sim: runSimulationHandler,
  audit: runAuditHandler,
  codegen: runCodegenHandler
};

function routeToCorrectHandler(mode: SupportedMode, payload: any) {
  const handler = handlerMap[mode] || runWriteHandler;
  return handler(payload);
}
