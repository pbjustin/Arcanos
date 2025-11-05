import OpenAI from 'openai';
import { runHealthCheck } from '../utils/diagnostics.js';
import { call_gpt5_strict, getGPT5Model } from '../services/openai.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import {
  getArcanosSystemPrompt,
  getArcanosUserPrompt,
  getSecureReasoningIntegrationPrompt
} from '../config/prompts.js';
import { 
  getAuditSafeConfig, 
  applyAuditSafeConstraints, 
  logAITaskLineage, 
  validateAuditSafeOutput,
  createAuditSummary,
  type AuditSafeConfig,
  type AuditLogEntry 
} from '../services/auditSafe.js';
import {
  getMemoryContext,
  storeDecision,
  storePattern,
  type MemoryContext
} from '../services/memoryAware.js';
import { mirrorDecisionEvent } from '../services/gpt4Shadow.js';
import { 
  executeSecureReasoning, 
  validateSecureReasoningRequest 
} from '../services/secureReasoningEngine.js';
import { logger } from '../utils/structuredLogging.js';
import { 
  applySecurityCompliance
} from '../services/securityCompliance.js';

interface ArcanosResult {
  result: string;
  componentStatus: string;
  suggestedFixes: string;
  coreLogicTrace: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
  activeModel: string;
  fallbackFlag: boolean;
  reasoningDelegation?: {
    used: boolean;
    reason?: string;
    delegatedQuery?: string;
  };
  gpt5Used?: boolean;
  auditSafe: {
    mode: boolean;
    overrideUsed: boolean;
    overrideReason?: string;
    auditFlags: string[];
    processedSafely: boolean;
  };
  memoryContext: {
    entriesAccessed: number;
    contextSummary: string;
    memoryEnhanced: boolean;
  };
  taskLineage: {
    requestId: string;
    logged: boolean;
  };
}

/**
 * Detect if secure reasoning delegation is needed based on user input
 * Secure reasoning is used for deep analysis while ARCANOS remains the governing brain
 */
function shouldDelegateToSecureReasoning(userInput: string): { shouldDelegate: boolean; reason?: string } {
  const lowercaseInput = userInput.toLowerCase();
  
  // Deep logic indicators
  const deepLogicKeywords = [
    'analyze complex', 'deep analysis', 'complex reasoning', 'intricate logic',
    'sophisticated algorithm', 'advanced reasoning', 'complex problem solving',
    'structured plan', 'problem-solving steps', 'methodology'
  ];
  
  // Code refactoring indicators
  const codeRefactoringKeywords = [
    'refactor', 'optimize code', 'restructure', 'improve architecture',
    'code quality', 'design patterns', 'best practices', 'clean code'
  ];
  
  // Long-context reasoning indicators
  const longContextKeywords = [
    'comprehensive analysis', 'full context', 'detailed breakdown',
    'extensive review', 'thorough examination', 'complete assessment'
  ];
  
  // Security-sensitive content indicators
  const securityKeywords = [
    'security analysis', 'compliance review', 'audit', 'sensitive data',
    'credentials', 'api key', 'token', 'password'
  ];
  
  // Check for deep logic needs
  for (const keyword of deepLogicKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Deep reasoning required for: ${keyword}` 
      };
    }
  }
  
  // Check for code refactoring needs
  for (const keyword of codeRefactoringKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Structured analysis needed for: ${keyword}` 
      };
    }
  }
  
  // Check for long-context reasoning needs
  for (const keyword of longContextKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Comprehensive reasoning needed for: ${keyword}` 
      };
    }
  }
  
  // Check for security-sensitive content
  for (const keyword of securityKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Security-compliant analysis required for: ${keyword}` 
      };
    }
  }
  
  // Check input length - very long inputs may benefit from structured reasoning
  if (userInput.length > APPLICATION_CONSTANTS.MAX_INPUT_LENGTH) {
    return { 
      shouldDelegate: true, 
      reason: 'Long input requires structured processing capability' 
    };
  }
  
  return { shouldDelegate: false };
}

/**
 * Delegate query to secure reasoning engine for deep analysis and structured problem-solving
 * Secure reasoning serves as the reasoning engine while ARCANOS governs the entire process
 */
async function delegateToSecureReasoning(client: OpenAI, userInput: string, reason: string, sessionId?: string): Promise<string> {
  logger.info('Delegating to secure reasoning engine', {
    module: 'arcanos',
    operation: 'secure-reasoning-delegation',
    reason,
    sessionId
  });
  
  try {
    // Validate input for security compliance first
    const validation = validateSecureReasoningRequest(userInput);
    
    if (!validation.valid) {
      logger.warn('Input validation issues detected', {
        module: 'arcanos',
        operation: 'security-validation', 
        issues: validation.issues,
        sessionId
      });
      // Use the sanitized input
      userInput = validation.safeInput;
    }
    
    // Execute secure reasoning analysis
    const reasoningResult = await executeSecureReasoning(client, {
      userInput,
      sessionId,
      context: `Delegation reason: ${reason}`,
      requireDeepAnalysis: true
    });
    
    logger.info('Secure reasoning analysis complete', {
      module: 'arcanos',
      operation: 'secure-reasoning-complete',
      complianceStatus: reasoningResult.complianceStatus,
      sessionId
    });
    
    // Process secure reasoning response through ARCANOS (never send reasoning output directly to user)
    const problemSolvingSteps = reasoningResult.problemSolvingSteps
      .map((step, index) => `${index + 1}. ${step}`)
      .join('\n');
    const recommendations = reasoningResult.recommendations
      .map((rec) => `• ${rec}`)
      .join('\n');
    
    const arcanosProcessingPrompt = getSecureReasoningIntegrationPrompt(
      userInput,
      reason,
      reasoningResult.complianceStatus,
      reasoningResult.structuredAnalysis,
      problemSolvingSteps,
      recommendations
    );

    return arcanosProcessingPrompt;
  } catch (error) {
    console.warn(`[❌ SECURE_REASONING] Analysis delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new Error(`Secure reasoning delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * Get the ARCANOS system prompt from configuration
 */
function getSystemPrompt(): string {
  return getArcanosSystemPrompt();
}

/**
 * Enhanced system prompt that includes memory context and audit-safe constraints
 */
function createEnhancedSystemPrompt(
  memoryContext: MemoryContext,
  auditConfig: AuditSafeConfig,
  health: any
): string {
  const systemPrompt = getSystemPrompt();
  const basePrompt = `${systemPrompt}

CURRENT SYSTEM STATUS:
- Memory Usage: ${health.summary}
- Node.js Version: ${process.version}
- Platform: ${process.platform}
- Architecture: ${process.arch}
- Environment: ${process.env.NODE_ENV || 'development'}
- Uptime: ${process.uptime().toFixed(1)}s

${memoryContext.memoryPrompt}`;

  // Apply audit-safe constraints
  const { systemPrompt: auditSafePrompt } = applyAuditSafeConstraints(
    basePrompt,
    '', // User prompt handled separately
    auditConfig
  );

  return auditSafePrompt;
}

/**
 * Wrap prompt before sending to ARCANOS with diagnostic format and memory context
 */
export const arcanosPrompt = (userInput: string, memoryContext?: MemoryContext): string => {
  return getArcanosUserPrompt(userInput, memoryContext?.contextSummary);
};

/**
 * Execute ARCANOS system diagnosis with structured response, audit-safe mode, and memory-aware reasoning
 */
export async function runARCANOS(
  client: OpenAI, 
  userInput: string, 
  sessionId?: string,
  overrideFlag?: string
): Promise<ArcanosResult> {
  console.log('[🔬 ARCANOS] Running system diagnosis with enhanced capabilities...');
  
  // Generate unique request ID for tracking
  const requestId = generateRequestId('arc');
  
  // Get audit-safe configuration
  const auditConfig = getAuditSafeConfig(userInput, overrideFlag);
  console.log(`[🔒 AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);
  
  // Get memory context for continuity
  const memoryContext = getMemoryContext(userInput, sessionId);
  console.log(`[🧠 MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);
  await mirrorDecisionEvent(client, requestId, 'memory_sync', memoryContext.contextSummary, 'agent_role_check');
  
  // Get current system health for context
  const health = await runHealthCheck();
  
  // Check if secure reasoning delegation is needed (memory-aware)
  const delegationCheck = shouldDelegateToSecureReasoning(userInput);
  let reasoningDelegation: { used: boolean; reason?: string; delegatedQuery?: string } = { used: false };
  let processedInput = userInput;
  
  if (delegationCheck.shouldDelegate) {
    const reason = delegationCheck.reason ?? 'unspecified reason';
    console.log(`[🧠 ARCANOS] Secure reasoning delegation required: ${reason}`);

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
    } catch (error) {
      console.warn(`[⚠️ ARCANOS] Secure reasoning delegation failed, proceeding with native processing: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Continue with original input if delegation fails
    }
  }
  
  // Create enhanced system prompt with memory context and audit-safe constraints
  const enhancedSystemPrompt = createEnhancedSystemPrompt(memoryContext, auditConfig, health);
  
  // Apply audit-safe constraints to user input
  const { userPrompt: auditSafeUserPrompt, auditFlags } = applyAuditSafeConstraints(
    '', // System prompt already enhanced
    processedInput,
    auditConfig
  );
  
  // Create the ARCANOS prompt with shell wrapper and memory context
  const prompt = arcanosPrompt(auditSafeUserPrompt, memoryContext);
  
  // Use strict GPT-5 calls only - no fallback allowed
  const gpt5Model = getGPT5Model();
  let finalResult: string;
  let response: any;
  
  try {
    // Use strict GPT-5 call with no fallback
    const tokenParams = getTokenParameter(gpt5Model, APPLICATION_CONSTANTS.EXTENDED_TOKEN_LIMIT);
    
    // Prepare messages for call_gpt5_strict
    const systemMessage = enhancedSystemPrompt;
    const userMessage = prompt;
    const combinedPrompt = `${systemMessage}\n\nUser: ${userMessage}`;
    
    console.log(`[🎯 ARCANOS] Using strict GPT-5 call with model: ${gpt5Model}`);
    response = await call_gpt5_strict(combinedPrompt, {
      temperature: 0.1, // Low temperature for consistent diagnostic output
      ...tokenParams,
    });

    finalResult =
      response.output_text ||
      response.output?.[0]?.content?.[0]?.text ||
      '';
    console.log(`[🔬 ARCANOS] Diagnosis complete using strict GPT-5: ${gpt5Model}`);
    
  } catch (err) {
    // No fallback - throw error immediately
    const errorMessage = `GPT-5 strict call failed — no fallback allowed: ${err instanceof Error ? err.message : 'Unknown error'}`;
    console.error(`❌ [ARCANOS] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  // Validate audit-safe output
  const processedSafely = validateAuditSafeOutput(finalResult, auditConfig);
  if (!processedSafely) {
    auditFlags.push('OUTPUT_VALIDATION_FAILED');
  }
  
  // Parse the structured response
  const parsedResult = parseArcanosResponse(
    finalResult, 
    response, 
    gpt5Model, 
    false, // No fallback used - always strict GPT-5
    reasoningDelegation,
    auditConfig,
    memoryContext,
    auditFlags,
    processedSafely,
    requestId
  );
  
  // Store successful patterns for learning
  if (processedSafely) {
    storePattern(
      'Successful ARCANOS diagnosis with strict GPT-5',
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

function parseArcanosResponse(
  fullResult: string, 
  response: OpenAI.Chat.Completions.ChatCompletion, 
  activeModel: string, 
  fallbackFlag: boolean,
  reasoningDelegation?: { used: boolean; reason?: string; delegatedQuery?: string },
  auditConfig?: AuditSafeConfig,
  memoryContext?: MemoryContext,
  auditFlags?: string[],
  processedSafely?: boolean,
  requestId?: string
): ArcanosResult {
  // Parse the structured response
  const componentStatusMatch = fullResult.match(/✅ Component Status Table\s*([\s\S]*?)(?=🛠|$)/);
  const suggestedFixesMatch = fullResult.match(/🛠 Suggested Fixes\s*([\s\S]*?)(?=🧠|$)/);
  const coreLogicTraceMatch = fullResult.match(/🧠 Core Logic Trace\s*([\s\S]*?)$/);
  
  const componentStatus = componentStatusMatch ? componentStatusMatch[1].trim() : 'Status information not available';
  const suggestedFixes = suggestedFixesMatch ? suggestedFixesMatch[1].trim() : 'No fixes suggested';
  let coreLogicTrace = coreLogicTraceMatch ? coreLogicTraceMatch[1].trim() : 'Logic trace not available';
  
  // Add secure reasoning delegation info to logic trace if used
  if (reasoningDelegation?.used) {
    coreLogicTrace = `Secure Reasoning Delegation: ${reasoningDelegation.reason}\nOriginal Query: ${reasoningDelegation.delegatedQuery}\n\n${coreLogicTrace}`;
  }
  
  // Add memory context info to logic trace
  if (memoryContext && memoryContext.relevantEntries.length > 0) {
    coreLogicTrace = `Memory Context: ${memoryContext.contextSummary}\nMemory Accessed: [${memoryContext.accessLog.join(', ')}]\n\n${coreLogicTrace}`;
  }

  // Apply security compliance to the final result
  const securityCheck = applySecurityCompliance(fullResult);
  if (securityCheck.complianceStatus !== 'COMPLIANT') {
    console.warn(`[🔒 SECURITY] Compliance issue detected: ${securityCheck.complianceStatus}`);
    // Use the redacted content
    fullResult = securityCheck.content;
    auditFlags?.push('SECURITY_REDACTION_APPLIED');
  }

  return {
    result: fullResult,
    componentStatus,
    suggestedFixes,
    coreLogicTrace,
    activeModel,
    fallbackFlag,
    reasoningDelegation,
    gpt5Used: true,
    auditSafe: {
      mode: auditConfig?.auditSafeMode ?? true,
      overrideUsed: !!auditConfig?.explicitOverride,
      overrideReason: auditConfig?.overrideReason,
      auditFlags: auditFlags || [],
      processedSafely: processedSafely ?? true
    },
    memoryContext: {
      entriesAccessed: memoryContext?.relevantEntries.length || 0,
      contextSummary: memoryContext?.contextSummary || 'No memory context available',
      memoryEnhanced: (memoryContext?.relevantEntries.length || 0) > 0
    },
    taskLineage: {
      requestId: requestId || 'unknown',
      logged: true
    },
    meta: {
      tokens: response.usage || undefined,
      id: response.id,
      created: response.created,
    },
  };
}