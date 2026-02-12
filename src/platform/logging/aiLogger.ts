/**
 * Enhanced logging for ARCANOS routing stages
 */
export function logArcanosRouting(stage: string, model: string, details?: string) {
  const timestamp = new Date().toISOString();
  console.log(`🔀 [ARCANOS ROUTING] ${timestamp} - ${stage} | Model: ${model}${details ? ` | ${details}` : ''}`);
}

/**
 * Log when ARCANOS routes to GPT-5.1
 */
export function logGPT5Invocation(reason: string, input: string) {
  const timestamp = new Date().toISOString();
  console.log(`🚀 [GPT-5.1 INVOCATION] ${timestamp} - Reason: ${reason} | Input: ${input.substring(0, 100)}${input.length > 100 ? '...' : ''}`);
}

/**
 * Log the final routing summary
 */
export function logRoutingSummary(arcanosModel: string, gpt5Used: boolean, finalStage: string) {
  const timestamp = new Date().toISOString();
  console.log(`📊 [ROUTING SUMMARY] ${timestamp} - ARCANOS: ${arcanosModel} | GPT-5.1 Used: ${gpt5Used} | Final Stage: ${finalStage}`);
}
