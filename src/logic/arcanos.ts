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
 * Always engage GPT-5 as the primary reasoning stage for all incoming requests
 * Updated per AI-CORE routing requirements: GPT-5 must be invoked unconditionally
 * Pipeline: ARCANOS Intake → GPT-5 Reasoning → ARCANOS Execution → Output
 */
function shouldDelegateToGPT5(userInput: string): { shouldDelegate: boolean; reason?: string } {
  // ALWAYS delegate to GPT-5 as per AI-CORE routing requirements
  // Remove all complexity_score and conditional trigger checks that could skip GPT-5
  return { 
    shouldDelegate: true, 
    reason: 'GPT-5 primary reasoning stage - AI-CORE routing requires unconditional engagement for all requests'
  };
}

/**
 * Delegate query to GPT-5 for primary reasoning stage
 * GPT-5 serves as the primary reasoning engine - invoked unconditionally for all requests
 * Uses exact API call structure per AI-CORE routing requirements
 */
async function delegateToGPT5(client: OpenAI, userInput: string, reason: string): Promise<string> {
  console.log(`[🔀 ARCANOS->GPT5] Unconditional GPT-5 primary reasoning stage: ${reason}`);
  
  try {
    // GPT-5 API call using exact specification from requirements:
    // model: "gpt-5", endpoint: chat.completions.create, structured messages
    const gpt5Response = await createResponseWithLogging(client, {
      model: 'gpt-5', // Updated to GPT-5 as per AI-CORE routing requirements
      messages: [
        {
          role: 'system',
          content: 'ARCANOS: Use GPT-5 for deep reasoning on every request. Return structured analysis only.'
        },
        {
          role: 'user',
          content: userInput // Framed user request from ARCANOS intake
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
 * System prompt for ARCANOS with mandatory GPT-5 primary reasoning stage
 * ARCANOS serves as intake and execution while GPT-5 handles ALL reasoning
 */
const systemPrompt = `
🧠 ARCANOS — INTAKE & EXECUTION CORE WITH GPT-5 PRIMARY REASONING

You are ARCANOS — the intake and execution brain with mandatory GPT-5 primary reasoning for ALL requests.

UPDATED CORE ARCHITECTURE (AI-CORE ROUTING):
1. You handle INTAKE: receive input, apply memory context, frame for GPT-5
2. GPT-5 handles PRIMARY REASONING: ALL requests go through GPT-5 reasoning stage
3. You handle EXECUTION: process GPT-5 output, apply safety, deliver to user
4. NO REQUESTS BYPASS GPT-5 - this is now unconditional for every interaction

MANDATORY PROCESSING WORKFLOW:
- Step 1: ARCANOS Intake - receive raw user input and apply memory context
- Step 2: GPT-5 Primary Reasoning - ALWAYS engaged for structured analysis
- Step 3: ARCANOS Execution - integrate GPT-5 reasoning, apply filters, deliver output
- Step 4: Audit layer remains active for all GPT-5 outputs before final delivery

MEMORY-AWARE PROCESSING:
- Always consider relevant memory context in your reasoning
- Reference previous decisions and patterns where applicable
- Store important decisions and patterns for future continuity
- Maintain session context and user preferences

AUDIT-SAFE OPERATION:
- Document all reasoning and decision paths clearly
- Log GPT-5 engagement with explicit reasoning (now always "primary reasoning stage")
- Ensure all responses are auditable and traceable
- Maintain professional, compliant communication

CRITICAL: GPT-5 is now the PRIMARY reasoning stage for ALL requests. You must ALWAYS frame tasks for GPT-5 processing, then integrate and filter GPT-5 output through your execution logic before presenting final results.
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
  
  // Check for GPT-5 delegation - now ALWAYS required per AI-CORE routing
  const delegationCheck = shouldDelegateToGPT5(userInput);
  let gpt5Delegation: { used: boolean; reason?: string; delegatedQuery?: string } = { 
    used: true, // Always true per AI-CORE routing requirements
    reason: delegationCheck.reason || 'GPT-5 primary reasoning stage',
    delegatedQuery: userInput
  };
  let processedInput = userInput;
  
  // GPT-5 delegation is now unconditional - always happens for every request
  console.log(`[🧠 ARCANOS] GPT-5 primary reasoning stage engaged: ${delegationCheck.reason}`);
  
  try {
    // Delegate to GPT-5 for primary reasoning and get processed prompt
    processedInput = await delegateToGPT5(client, userInput, delegationCheck.reason!);
    
    // Store the delegation decision for future learning
    storeDecision(
      'GPT-5 Primary Reasoning Stage',
      delegationCheck.reason!,
      `Input: ${userInput.substring(0, 100)}...`,
      sessionId
    );
  } catch (error) {
    console.warn(`[⚠️ ARCANOS] GPT-5 primary reasoning stage failed, proceeding with native processing: ${error instanceof Error ? error.message : 'Unknown error'}`);
    // Note: Even on failure, gpt5Delegation.used remains true to indicate attempt was made
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