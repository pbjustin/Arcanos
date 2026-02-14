/**
 * Centralized watchdog timeout configuration.
 * Model-aware adaptive timeouts with reasoning depth scaling.
 */

export const TIMEOUT_MAP: Record<string, number> = {
  "gpt-5": 45000,
  "gpt-4o": 35000,
  "gpt-3.5-turbo": 25000,
  "finetune": 30000,
  "default": 30000
};

export const MAX_TIMEOUT = 60000;

export function resolveTimeout(model: string, reasoningDepth = 1): number {
  const base = Object.prototype.hasOwnProperty.call(TIMEOUT_MAP, model) 
    ? TIMEOUT_MAP[model] 
    : TIMEOUT_MAP["default"];
  
  const safeDepth = (typeof reasoningDepth === 'number' && !isNaN(reasoningDepth)) 
    ? Math.max(0, reasoningDepth) 
    : 1;
    
  const multiplier = Math.min(safeDepth, 3);
  const resolved = base + (multiplier * 5000);
  return Math.max(1000, Math.min(resolved, MAX_TIMEOUT));
}
