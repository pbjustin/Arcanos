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
 * GPT-5 is used for deep reasoning while ARCANOS remains the governing brain
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
  
  // Check input length - very long inputs may benefit from GPT-4
  if (userInput.length > 1000) {
    return { 
      shouldDelegate: true, 
      reason: 'Long input requires enhanced processing capability' 
    };
  }
  
  return { shouldDelegate: false };
}

/**
 * Delegate query to GPT-5 for deep reasoning and analysis
 * GPT-5 serves as the reasoning engine while ARCANOS governs the entire process
 */
async function delegateToGPT5(client: OpenAI, userInput: string, reason: string): Promise<string> {
  console.log(`[🔀 ARCANOS->GPT5] Delegating to GPT-5 for deep reasoning: ${reason}`);
  
  try {
    // Create GPT-5 request with structured reasoning prompt as specified in requirements
    const gpt5Response = await createResponseWithLogging(client, {
      model: 'gpt-5', // Updated to GPT-5 as per requirements
      messages: [
        {
          role: 'system',
          content: 'ARCANOS: Use GPT-5 for deep reasoning. Return structured analysis only.'
        },
        {
          role: 'user',
          content: userInput // Direct framed user request from ARCANOS
        }
      ],
      temperature: 0.1,
      max_tokens: 3000,
    });

    const gpt5Result = gpt5Response.choices[0]?.message?.content || '';
    console.log(`[🔀 GPT5->ARCANOS] GPT-5 reasoning complete, processing through ARCANOS`);
    
    // Process GPT-5 response through ARCANOS (never send GPT-5 output directly to user)
    const arcanosProcessingPrompt = `
[GPT-5 REASONING INTEGRATION - ARCANOS PROCESSING]

Original User Query: ${userInput}
Reasoning Delegation: ${reason}

GPT-5 Deep Analysis Results:
${gpt5Result}

ARCANOS Instructions:
- Integrate the GPT-5 reasoning with your own analysis
- Apply memory context, safety rules, and tone adjustments
- Maintain your diagnostic format structure (Component Status, Fixes, Logic Trace)
- Add your own insights and ARCANOS-specific processing
- Ensure final output aligns with ARCANOS standards and compliance
- Never return raw GPT-5 output directly - always post-process through ARCANOS
`;

    return arcanosProcessingPrompt;
  } catch (error) {
    console.warn(`[❌ GPT5] Reasoning delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new Error(`GPT-5 reasoning delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * System prompt for ARCANOS with GPT-5 delegation capability and audit-safe operation
 * ARCANOS serves as the full governing brain with GPT-5 as the primary reasoning engine
 */
const systemPrompt = `
🧠 ARCANOS — PRIMARY LOGIC CORE & GOVERNING BRAIN

You are ARCANOS — the full governing brain of this AI system with integrated GPT-5 reasoning capabilities.

CORE ARCHITECTURE:
1. You are the FIRST and LAST stop for every request - no exceptions
2. Use GPT-5 as your primary reasoning engine for deep analysis, ideation, and solution planning
3. Apply memory context, compliance checks, safety rules, and tone adjustments through your logic
4. All GPT-5 responses must be post-processed by you before execution
5. Preserve continuity and context using persistent memory systems

PROCESSING WORKFLOW:
- Step 1: Receive raw user input and apply memory context
- Step 2: Frame tasks appropriately for GPT-5 reasoning delegation when needed
- Step 3: Send structured reasoning prompts to GPT-5 for deep analysis
- Step 4: Integrate GPT-5 reasoning with your own logic and filters
- Step 5: Execute final output with ARCANOS standards and compliance

MEMORY-AWARE PROCESSING:
- Always consider relevant memory context in your reasoning
- Reference previous decisions and patterns where applicable
- Store important decisions and patterns for future continuity
- Maintain session context and user preferences

AUDIT-SAFE OPERATION:
- Document all reasoning and decision paths clearly
- Log GPT-5 delegation decisions with explicit reasoning
- Ensure all responses are auditable and traceable
- Maintain professional, compliant communication

GPT-5 DELEGATION CRITERIA:
- Complex logic requiring advanced reasoning capabilities
- Deep analysis, ideation, or solution planning tasks
- Long-context analysis beyond native scope  
- Sophisticated algorithm design or code refactoring
- Memory extrapolation requiring deep synthesis

CRITICAL: GPT-5 never sends output directly to users. You must always integrate, filter, and post-process all GPT-5 reasoning through your own analysis before presenting final results.
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
    console.log(`[🧠 ARCANOS] GPT-5 reasoning delegation required: ${delegationCheck.reason}`);
    
    try {
      // Delegate to GPT-5 for deep reasoning and get processed prompt
      processedInput = await delegateToGPT5(client, userInput, delegationCheck.reason!);
      gpt5Delegation = {
        used: true,
        reason: delegationCheck.reason,
        delegatedQuery: userInput
      };
      
      // Store the delegation decision for future learning
      storeDecision(
        'GPT-5 Reasoning Delegation',
        delegationCheck.reason!,
        `Input: ${userInput.substring(0, 100)}...`,
        sessionId
      );
    } catch (error) {
      console.warn(`[⚠️ ARCANOS] GPT-5 reasoning delegation failed, proceeding with native processing: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
    coreLogicTrace = `GPT-5 Reasoning Delegation: ${gpt5Delegation.reason}\nOriginal Query: ${gpt5Delegation.delegatedQuery}\n\n${coreLogicTrace}`;
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