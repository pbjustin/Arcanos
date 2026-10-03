import { GAMING_GENERATION_TERMINAL_HEADROOM_MS } from "@shared/gaming/gamingGenerationBudgetCore.js";

export const GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS = 60_000;
export const DEFAULT_GAMING_MODULE_TIMEOUT_MS = GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS;
export const DEFAULT_GAMING_PIPELINE_TIMEOUT_MS = 50_000;
export const DEFAULT_GAMING_GUIDE_PIPELINE_TIMEOUT_MS = DEFAULT_GAMING_PIPELINE_TIMEOUT_MS;
export const GAMING_EXECUTION_OUTER_HEADROOM_MS = 10_000;
export const GAMING_PROVIDER_DISPATCH_HEADROOM_MS = 5_000;

function boundedMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Resolve the provider-capable request envelope before allocating Trinity stages.
 * Module/operator limits and the remaining caller deadline are hard parents.
 * Outer headroom covers acquisition/setup, serialization and cancellation; the
 * stage allocator separately retains answer-audit and terminal pipeline time.
 * An exhausted parent yields zero usable pipeline time, never a new deadline.
 */
export function resolveGamingExecutionBudget(params: {
  moduleTimeoutMs?: number;
  requestRemainingMs?: number | null;
  configuredPipelineTimeoutMs?: number;
} = {}) {
  const moduleTimeoutMs = Math.min(GAMING_PROVIDER_BACKED_MCP_TIMEOUT_MS,
    boundedMs(params.moduleTimeoutMs ?? DEFAULT_GAMING_MODULE_TIMEOUT_MS));
  const requestRemainingMs = params.requestRemainingMs == null
    ? moduleTimeoutMs : boundedMs(params.requestRemainingMs);
  const mcpOperationTimeoutMs = Math.min(moduleTimeoutMs, requestRemainingMs);
  const outerHeadroomMs = Math.min(GAMING_EXECUTION_OUTER_HEADROOM_MS, mcpOperationTimeoutMs);
  const pipelineTimeoutMs = Math.min(DEFAULT_GAMING_PIPELINE_TIMEOUT_MS,
    boundedMs(params.configuredPipelineTimeoutMs ?? DEFAULT_GAMING_PIPELINE_TIMEOUT_MS),
    mcpOperationTimeoutMs - outerHeadroomMs);

  return {
    mcpOperationTimeoutMs,
    pipelineTimeoutMs,
    requestRemainingMs,
    outerHeadroomMs,
    providerDispatchHeadroomMs: Math.min(GAMING_PROVIDER_DISPATCH_HEADROOM_MS, outerHeadroomMs),
    terminalReserveMs: Math.min(GAMING_GENERATION_TERMINAL_HEADROOM_MS, pipelineTimeoutMs)
  };
}
