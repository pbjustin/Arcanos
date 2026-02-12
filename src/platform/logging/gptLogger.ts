/**
 * Logging helpers for GPT connection acknowledgment events.
 * Follows the aiLogger.ts pattern: standalone exported functions,
 * emoji-prefixed console.log, ISO timestamps.
 */

export type GptMatchMethod = 'exact' | 'substring' | 'token-subset' | 'fuzzy' | 'none';

export interface GptRoutingInfo {
  gptId: string;
  moduleName: string;
  route: string;
  matchMethod: GptMatchMethod;
}

/**
 * Log when a GPT connects and is matched to a module.
 */
export function logGptConnection(info: GptRoutingInfo): void {
  const timestamp = new Date().toISOString();
  console.log(
    `🔗 [GPT CONNECTION] ${timestamp} - GPT: ${info.gptId} | Module: ${info.moduleName} | Route: ${info.route} | Match: ${info.matchMethod}`
  );
}

/**
 * Log when a GPT connection fails to match any module.
 */
export function logGptConnectionFailed(gptId: string): void {
  const timestamp = new Date().toISOString();
  console.log(
    `❌ [GPT CONNECTION] ${timestamp} - GPT: ${gptId} | No matching module found`
  );
}

/**
 * Log the final acknowledgment being sent back to the GPT.
 */
export function logGptAckSent(info: GptRoutingInfo, actionCount: number): void {
  const timestamp = new Date().toISOString();
  console.log(
    `✅ [GPT ACK] ${timestamp} - GPT: ${info.gptId} → ${info.moduleName} | Actions: ${actionCount} | Match: ${info.matchMethod}`
  );
}
