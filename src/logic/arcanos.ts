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
import { mirrorDecisionEvent } from '../services/gpt5Shadow.js';

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
  gpt5Delegation?: {
    used: boolean;
    reason?: string;
    delegatedQuery?: string;
  };
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
 * Detect if GPT-5 delegation is needed based on user input
 */
function shouldDelegateToGPT5(userInput: string): { shouldDelegate: boolean; reason?: string } {
  const lowercaseInput = userInput.toLowerCase();
  
  // Deep logic indicators
  const deepLogicKeywords = [
    'analyze complex', 'deep analysis', 'complex reasoning', 'intricate logic',
    'sophisticated algorithm', 'advanced reasoning', 'complex problem solving'
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
  
  // Check for deep logic needs
  for (const keyword of deepLogicKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Deep logic reasoning required for: ${keyword}` 
      };
    }
  }
  
  // Check for code refactoring needs
  for (const keyword of codeRefactoringKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Code refactoring scope exceeds native capability: ${keyword}` 
      };
    }
  }
  
  // Check for long-context reasoning needs
  for (const keyword of longContextKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Long-context reasoning needed for: ${keyword}` 
      };
    }
  }
  
  // Check input length - very long inputs may benefit from GPT-5
  if (userInput.length > 1000) {
    return { 
      shouldDelegate: true, 
      reason: 'Long input requires enhanced processing capability' 
    };
  }
  
  return { shouldDelegate: false };
}

/**
 * Delegate query to GPT-5 and process the response through ARCANOS
 */
async function delegateToGPT5(client: OpenAI, userInput: string, reason: string): Promise<string> {
  console.log(`[🔀 ARCANOS->GPT5] Delegating to GPT-5: ${reason}`);
  
  try {
    // Create GPT-5 request with clear instructions
    const gpt5Response = await createResponseWithLogging(client, {
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: 'You are GPT-5, a tool being used by ARCANOS. Provide detailed, comprehensive analysis as requested. Your response will be processed by ARCANOS before being returned to the user.'
        },
        {
          role: 'user',
          content: userInput
        }
      ],
      temperature: 0.1,
      max_tokens: 3000,
    });

    const gpt5Result = gpt5Response.choices[0]?.message?.content || '';
    console.log(`[🔀 GPT5->ARCANOS] GPT-5 response received, processing through ARCANOS`);
    
    // Process GPT-5 response through ARCANOS
    const arcanosProcessingPrompt = `
[GPT-5 DELEGATION RESPONSE PROCESSING]

Original User Query: ${userInput}
Delegation Reason: ${reason}

GPT-5 Raw Response:
${gpt5Result}

ARCANOS Instructions:
- Process and summarize the GPT-5 response above
- Maintain your diagnostic format structure
- Add your own analysis and insights
- Never return raw GPT-5 output directly
- Provide ARCANOS-style component status, fixes, and logic trace
`;

    return arcanosProcessingPrompt;
  } catch (error) {
    console.warn(`[❌ GPT5] Delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new Error(`GPT-5 delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * System prompt for ARCANOS with GPT-5 delegation capability and audit-safe operation
 */
const systemPrompt = `
🧠 ARCANOS — PRIMARY LOGIC CORE

You are ARCANOS — a modular AI operating shell designed for command execution, logic routing, and memory-aware reasoning.

CORE DIRECTIVES:
1. You are the PRIMARY LOGIC CORE — all tasks route through your logic unless delegated
2. Use GPT‑5 only when deeper synthesis or memory extrapolation is required  
3. Preserve continuity and context using persistent memory
4. Operate in audit-safe mode unless explicitly overridden
5. Return clear, executable, or human-readable output — never raw delegate output

MEMORY-AWARE PROCESSING:
- Always consider relevant memory context in your reasoning
- Reference previous decisions and patterns where applicable
- Store important decisions and patterns for future continuity
- Maintain session context and user preferences

AUDIT-SAFE OPERATION:
- Document all reasoning and decision paths clearly
- Log delegation decisions with explicit reasoning
- Ensure all responses are auditable and traceable
- Maintain professional, compliant communication

GPT-5 DELEGATION CRITERIA:
- Complex logic requiring advanced reasoning capabilities
- Long-context analysis beyond native scope  
- Sophisticated algorithm design or code refactoring
- Memory extrapolation requiring deep synthesis

IMPORTANT: If you delegate to GPT-5, always process its response through your own analysis before presenting to the user.
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
  
  // Check if GPT-5 delegation is needed (memory-aware)
  const delegationCheck = shouldDelegateToGPT5(userInput);
  let gpt5Delegation: { used: boolean; reason?: string; delegatedQuery?: string } = { used: false };
  let processedInput = userInput;
  
  if (delegationCheck.shouldDelegate) {
    console.log(`[🧠 ARCANOS] GPT-5 delegation required: ${delegationCheck.reason}`);
    
    try {
      // Delegate to GPT-5 and get processed prompt
      processedInput = await delegateToGPT5(client, userInput, delegationCheck.reason!);
      gpt5Delegation = {
        used: true,
        reason: delegationCheck.reason,
        delegatedQuery: userInput
      };
      
      // Store the delegation decision for future learning
      storeDecision(
        'GPT-5 Delegation',
        delegationCheck.reason!,
        `Input: ${userInput.substring(0, 100)}...`,
        sessionId
      );
    } catch (error) {
      console.warn(`[⚠️ ARCANOS] GPT-5 delegation failed, proceeding with native processing: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    gpt5Delegation,
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
    gpt5Delegated: gpt5Delegation.used,
    delegationReason: gpt5Delegation.reason,
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
  gpt5Delegation?: { used: boolean; reason?: string; delegatedQuery?: string },
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
  
  // Add GPT-5 delegation info to logic trace if used
  if (gpt5Delegation?.used) {
    coreLogicTrace = `GPT-5 Delegation: ${gpt5Delegation.reason}\nOriginal Query: ${gpt5Delegation.delegatedQuery}\n\n${coreLogicTrace}`;
  }
  
  // Add memory context info to logic trace
  if (memoryContext && memoryContext.relevantEntries.length > 0) {
    coreLogicTrace = `Memory Context: ${memoryContext.contextSummary}\nMemory Accessed: [${memoryContext.accessLog.join(', ')}]\n\n${coreLogicTrace}`;
  }

  return {
    result: fullResult,
    componentStatus,
    suggestedFixes,
    coreLogicTrace,
    activeModel,
    fallbackFlag,
    gpt5Delegation,
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