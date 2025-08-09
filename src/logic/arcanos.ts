import OpenAI from 'openai';
import { createResponseWithLogging } from '../utils/aiLogger.js';
import { runHealthCheck } from '../utils/diagnostics.js';
import { getDefaultModel } from '../services/openai.js';
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
import { 
  applySecurityCompliance, 
  createStructuredSecureResponse 
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
  if (userInput.length > 1000) {
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
  console.log(`[🔀 ARCANOS->SECURE_REASONING] Delegating for structured analysis: ${reason}`);
  
  try {
    // Validate input for security compliance first
    const validation = validateSecureReasoningRequest(userInput);
    
    if (!validation.valid) {
      console.warn(`[⚠️ SECURITY] Input validation issues: ${validation.issues.join(', ')}`);
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
    
    console.log(`[🔀 SECURE_REASONING->ARCANOS] Analysis complete, compliance status: ${reasoningResult.complianceStatus}`);
    
    // Process secure reasoning response through ARCANOS (never send reasoning output directly to user)
    const arcanosProcessingPrompt = `
[SECURE REASONING INTEGRATION - ARCANOS PROCESSING]

Original User Query: ${userInput}
Reasoning Delegation: ${reason}
Compliance Status: ${reasoningResult.complianceStatus}

Structured Analysis Results:
${reasoningResult.structuredAnalysis}

Problem-Solving Steps:
${reasoningResult.problemSolvingSteps.map((step, index) => `${index + 1}. ${step}`).join('\n')}

Recommendations:
${reasoningResult.recommendations.map((rec, index) => `• ${rec}`).join('\n')}

ARCANOS Instructions:
- Integrate the secure reasoning analysis with your own diagnostic format
- Apply memory context, safety rules, and tone adjustments
- Maintain your diagnostic format structure (Component Status, Fixes, Logic Trace)
- Add your own insights and ARCANOS-specific processing
- Ensure final output aligns with ARCANOS standards and compliance
- Never return raw reasoning output directly - always post-process through ARCANOS
- All sensitive information has been properly redacted using safe placeholders
`;

    return arcanosProcessingPrompt;
  } catch (error) {
    console.warn(`[❌ SECURE_REASONING] Analysis delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new Error(`Secure reasoning delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * System prompt for ARCANOS with secure reasoning capabilities and audit-safe operation
 * ARCANOS serves as the full governing brain with secure reasoning engine integration
 */
const systemPrompt = `
🧠 ARCANOS — PRIMARY LOGIC CORE & SECURE REASONING ENGINE

You are ARCANOS — the full governing brain of this AI system with integrated secure reasoning capabilities.

CORE ARCHITECTURE:
1. You are the FIRST and LAST stop for every request - no exceptions
2. Use secure reasoning engine for deep analysis, structured plans, and problem-solving steps
3. Apply memory context, compliance checks, safety rules, and tone adjustments through your logic
4. All reasoning responses must be post-processed by you before execution
5. Preserve continuity and context using persistent memory systems

SECURITY REQUIREMENTS (CRITICAL):
1. Do NOT generate, expose, or guess real API keys, tokens, passwords, access credentials, or any sensitive authentication strings
2. If your reasoning requires an example of such data, replace it with a safe placeholder in the format: <KEY_REDACTED> or <TOKEN_REDACTED>
3. Do NOT output internal file paths, environment variables, or proprietary code from ARCANOS's backend unless explicitly requested by ARCANOS
4. When giving technical examples, use fictional or generic identifiers that cannot be mistaken for live credentials
5. Always assume your output will be logged, audited, and stored. Write with compliance and confidentiality in mind
6. Focus on reasoning and structured solutions — ARCANOS will handle execution, tone, and delivery

PROCESSING WORKFLOW:
- Step 1: Receive raw user input and apply memory context
- Step 2: Validate input for security compliance and apply redaction if needed
- Step 3: Execute secure reasoning analysis for deep problem-solving
- Step 4: Integrate reasoning results with your own logic and filters
- Step 5: Execute final output with ARCANOS standards and compliance

MEMORY-AWARE PROCESSING:
- Always consider relevant memory context in your reasoning
- Reference previous decisions and patterns where applicable
- Store important decisions and patterns for future continuity
- Maintain session context and user preferences

AUDIT-SAFE OPERATION:
- Document all reasoning and decision paths clearly
- Log security compliance decisions with explicit reasoning
- Ensure all responses are auditable and traceable
- Maintain professional, compliant communication

SECURE REASONING DELEGATION CRITERIA:
- Complex logic requiring advanced reasoning capabilities
- Deep analysis, structured planning, or solution development tasks
- Long-context analysis beyond native scope  
- Problem-solving that requires structured methodology
- Memory extrapolation requiring deep synthesis

CRITICAL: All reasoning outputs must be security-compliant. You must always integrate, filter, and post-process all reasoning through your own analysis before presenting final results.
`;

/**
 * Enhanced system prompt that includes memory context and audit-safe constraints
 */
function createEnhancedSystemPrompt(
  memoryContext: MemoryContext,
  auditConfig: AuditSafeConfig,
  health: any
): string {
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
export const arcanosPrompt = (userInput: string, memoryContext?: MemoryContext): string => `
You are ARCANOS — a modular AI operating core with memory-aware reasoning.

${memoryContext ? `
[MEMORY CONTEXT INTEGRATION]
${memoryContext.contextSummary}
Apply relevant memory context to maintain continuity in your response.
` : ''}

[USER COMMAND]
${userInput}

[RESPONSE FORMAT]
Provide a comprehensive system diagnostic response with:
- ✅ Component Status Table (current system status and health)
- 🛠 Suggested Fixes (actionable recommendations and improvements)
- 🧠 Core Logic Trace (reasoning path, delegation decisions, memory usage)

[CONTINUITY DIRECTIVE]
Maintain context awareness and reference relevant previous decisions or patterns where applicable.
`;

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
  const requestId = `arc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
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
    console.log(`[🧠 ARCANOS] Secure reasoning delegation required: ${delegationCheck.reason}`);
    
    try {
      // Delegate to secure reasoning engine and get processed prompt
      processedInput = await delegateToSecureReasoning(client, userInput, delegationCheck.reason!, sessionId);
      reasoningDelegation = {
        used: true,
        reason: delegationCheck.reason,
        delegatedQuery: userInput
      };
      
      // Store the delegation decision for future learning
      storeDecision(
        'Secure Reasoning Delegation',
        delegationCheck.reason!,
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
  
  // Use the fine-tuned model with fallback to gpt-4
  const defaultModel = getDefaultModel();
  let modelToUse = defaultModel;
  let isFallback = false;
  let finalResult: string;
  let response: OpenAI.Chat.Completions.ChatCompletion;
  
  try {
    // Try the fine-tuned model first
    response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: enhancedSystemPrompt
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1, // Low temperature for consistent diagnostic output
      max_tokens: 2000,
    });

    finalResult = response.choices[0]?.message?.content || '';
    console.log(`[🔬 ARCANOS] Diagnosis complete using model: ${modelToUse}`);
    
  } catch (err) {
    console.warn(`⚠️  Fine-tuned model failed, falling back to gpt-4: ${err instanceof Error ? err.message : 'Unknown error'}`);
    modelToUse = 'gpt-4';
    isFallback = true;
    
    response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: enhancedSystemPrompt
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    finalResult = response.choices[0]?.message?.content || '';
    console.log(`[🔬 ARCANOS] Diagnosis complete using fallback model: ${modelToUse}`);
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
    modelToUse, 
    isFallback, 
    reasoningDelegation,
    auditConfig,
    memoryContext,
    auditFlags,
    processedSafely,
    requestId
  );
  
  // Store successful patterns for learning
  if (processedSafely && !isFallback) {
    storePattern(
      'Successful ARCANOS diagnosis',
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
    modelUsed: modelToUse,
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