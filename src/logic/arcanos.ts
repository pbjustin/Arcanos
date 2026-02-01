import type OpenAI from 'openai';
import { runHealthCheck } from '../utils/diagnostics.js';
import { call_gpt5_strict, getGPT5Model } from '../services/openai.js';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import {
  getAuditSafeConfig,
  applyAuditSafeConstraints,
  logAITaskLineage,
  validateAuditSafeOutput,
  createAuditSummary,
  type AuditLogEntry
} from '../services/auditSafe.js';
import {
  getMemoryContext,
  storeDecision,
  storePattern
} from '../services/memoryAware.js';
import { mirrorDecisionEvent } from '../services/gpt4Shadow.js';
import { shouldDelegateToSecureReasoning, delegateToSecureReasoning } from './arcanos/secureReasoning.js';
import { createEnhancedSystemPrompt, arcanosPrompt } from './arcanos/prompts.js';
import { parseArcanosResponse } from './arcanos/parsing.js';
import type { ArcanosResult } from './arcanos/types.js';

type GPT5StrictResponse = OpenAI.Chat.Completions.ChatCompletion & {
  output_text?: string;
  output?: Array<{ content?: Array<{ text?: string }> }>;
};

export { arcanosPrompt } from './arcanos/prompts.js';
export type { ArcanosResult } from './arcanos/types.js';

/**
 * Execute ARCANOS system diagnosis with structured response, audit-safe mode, and memory-aware reasoning
 */
export async function runARCANOS(
  client: OpenAI, 
  userInput: string, 
  sessionId?: string,
  overrideFlag?: string
): Promise<ArcanosResult> {
  console.log('[ðŸ”¬ ARCANOS] Running system diagnosis with enhanced capabilities...');
  
  // Generate unique request ID for tracking
  const requestId = generateRequestId('arc');
  
  // Get audit-safe configuration
  const auditConfig = getAuditSafeConfig(userInput, overrideFlag);
  console.log(`[ðŸ”’ AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);
  
  // Get memory context for continuity
  const memoryContext = getMemoryContext(userInput, sessionId);
  console.log(`[ðŸ§  MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);
  await mirrorDecisionEvent(client, requestId, 'memory_sync', memoryContext.contextSummary, 'agent_role_check');
  
  // Get current system health for context
  const health = await runHealthCheck();
  
  // Check if secure reasoning delegation is needed (memory-aware)
  const delegationCheck = shouldDelegateToSecureReasoning(userInput);
  let reasoningDelegation: { used: boolean; reason?: string; delegatedQuery?: string } = { used: false };
  let processedInput = userInput;
  
  //audit Assumption: delegation should only occur when flagged
  if (delegationCheck.shouldDelegate) {
    const reason = delegationCheck.reason ?? 'unspecified reason';
    console.log(`[ðŸ§  ARCANOS] Secure reasoning delegation required: ${reason}`);

    try {
      // Delegate to secure reasoning engine and get processed prompt
      processedInput = await delegateToSecureReasoning(client, userInput, reason, sessionId);
      reasoningDelegation = {
        used: true,
        reason,
        delegatedQuery: userInput
      };

      // Store the delegation decision for future learning
      storeDecision(
        'Secure Reasoning Delegation',
        reason,
        `Input: ${userInput.substring(0, 100)}...`,
        sessionId
      );
    } catch (error: unknown) {
      //audit Assumption: delegation failure should continue with original input
      const errorMessage = resolveErrorMessage(error);
      console.warn(`[âš ï¸ ARCANOS] Secure reasoning delegation failed, proceeding with native processing: ${errorMessage}`);
      // Continue with original input if delegation fails
    }
  }
  
  // Create enhanced system prompt with memory context and audit-safe constraints
  const enhancedSystemPrompt = createEnhancedSystemPrompt(memoryContext, auditConfig, health);
  
  // Apply audit-safe constraints to user input
  //audit Assumption: audit-safe constraints must be applied to user prompt
  const { userPrompt: auditSafeUserPrompt, auditFlags } = applyAuditSafeConstraints(
    '', // System prompt already enhanced
    processedInput,
    auditConfig
  );
  
  // Create the ARCANOS prompt with shell wrapper and memory context
  const prompt = arcanosPrompt(auditSafeUserPrompt, memoryContext);
  
  // Use strict GPT-5.1 calls only - no fallback allowed
  const gpt5Model = getGPT5Model();
  let finalResult: string;
  let response: GPT5StrictResponse | null = null;
  
  try {
    // Use strict GPT-5.1 call with no fallback
    const tokenParams = getTokenParameter(gpt5Model, APPLICATION_CONSTANTS.EXTENDED_TOKEN_LIMIT);
    
    // Prepare messages for call_gpt5_strict
    const systemMessage = enhancedSystemPrompt;
    const userMessage = prompt;
    const combinedPrompt = `${systemMessage}\n\nUser: ${userMessage}`;
    
    console.log(`[ðŸŽ¯ ARCANOS] Using strict GPT-5.1 call with model: ${gpt5Model}`);
    response = await call_gpt5_strict(combinedPrompt, {
      temperature: 0.1, // Low temperature for consistent diagnostic output
      ...tokenParams,
    });

    finalResult =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      '';
    console.log(`[ðŸ”¬ ARCANOS] Diagnosis complete using strict GPT-5.1: ${gpt5Model}`);
    
  } catch (err: unknown) {
    // No fallback - throw error immediately
    //audit Assumption: strict GPT-5 errors should be fatal
    const errorMessage = `GPT-5.1 strict call failed â€” no fallback allowed: ${resolveErrorMessage(err)}`;
    console.error(`âŒ [ARCANOS] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  if (!response) {
    throw new Error('GPT-5.1 strict call returned no response');
  }

  // Validate audit-safe output
  const processedSafely = validateAuditSafeOutput(finalResult, auditConfig);
  //audit Assumption: failed validation should add audit flag
  if (!processedSafely) {
    auditFlags.push('OUTPUT_VALIDATION_FAILED');
  }
  
  // Parse the structured response
  const parsedResult = parseArcanosResponse(
    finalResult, 
    response, 
    gpt5Model, 
    false, // No fallback used - always strict GPT-5.1
    reasoningDelegation,
    auditConfig,
    memoryContext,
    auditFlags,
    processedSafely,
    requestId
  );
  
  // Store successful patterns for learning
  if (processedSafely) {
    //audit Assumption: successful outputs should be stored for learning
    storePattern(
      'Successful ARCANOS diagnosis with strict GPT-5.1',
      [`Input pattern: ${userInput.substring(0, 50)}...`, `Output pattern: ${finalResult.substring(0, 50)}...`],
      sessionId
    );
  }
  
  // Log the complete task lineage for audit
  const auditLogEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    endpoint: 'arcanos',
    auditSafeMode: auditConfig.auditSafeMode,
    overrideUsed: !!auditConfig.explicitOverride,
    overrideReason: auditConfig.overrideReason,
    inputSummary: createAuditSummary(userInput),
    outputSummary: createAuditSummary(finalResult),
    modelUsed: gpt5Model,
    gpt5Delegated: reasoningDelegation.used,
    delegationReason: reasoningDelegation.reason,
    memoryAccessed: memoryContext.accessLog,
    processedSafely,
    auditFlags
  };
  
  logAITaskLineage(auditLogEntry);

  await mirrorDecisionEvent(client, requestId, 'audit', JSON.stringify(auditLogEntry), 'agent_role_check');
  await mirrorDecisionEvent(client, requestId, 'task_dispatch', finalResult, 'content_generation');

  return parsedResult;
}
