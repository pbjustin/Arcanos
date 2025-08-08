import OpenAI from 'openai';
import { createResponseWithLogging, logArcanosRouting, logGPT5Invocation, logRoutingSummary } from '../utils/aiLogger.js';
import { getDefaultModel, createChatCompletionWithFallback } from '../services/openai.js';
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

interface TrinityResult {
  result: string;
  module: string;
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
  routingStages?: string[];
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

interface BrainHook {
  next_model: string;
  purpose?: string;
  input?: string;
}

// Check for the fine-tuned model, fallback to GPT-4 if unavailable
const validateModel = async (client: OpenAI) => {
  const defaultModel = getDefaultModel();
  try {
    // Extract model name from fine-tuned ID for validation
    const modelToCheck = defaultModel.startsWith('ft:') ? defaultModel : defaultModel;
    await client.models.retrieve(modelToCheck);
    console.log(`✅ Fine-tuned model ${defaultModel} is available`);
    return defaultModel;
  } catch (err) {
    console.warn(`⚠️  Model ${defaultModel} unavailable. Falling back to GPT-4.`);
    console.warn(`🔄 Fallback reason: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return "gpt-4";
  }
};

/**
 * Process a user prompt through the ARCANOS brain with enhanced capabilities:
 * - Memory-aware reasoning with persistent context
 * - Audit-safe mode as default operating mode  
 * - Enhanced GPT-5 routing with decision tracking
 * - Complete task lineage logging to disk
 * 
 * ARCANOS serves as the primary logic core - all tasks route through it unless delegated.
 * GPT-5 is used only for deeper synthesis or memory extrapolation.
 * All responses are auditable and traceable with clear reasoning paths.
 */
export async function runThroughBrain(
  client: OpenAI, 
  prompt: string,
  sessionId?: string,
  overrideFlag?: string
): Promise<TrinityResult> {
  // Generate unique request ID for tracking
  const requestId = `trinity_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  
  const routingStages: string[] = [];
  let gpt5Used = false;
  
  // Get audit-safe configuration
  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  console.log(`[🔒 TRINITY AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);
  
  // Get memory context for continuity and better reasoning
  const memoryContext = getMemoryContext(prompt, sessionId);
  console.log(`[🧠 TRINITY MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);
  await mirrorDecisionEvent(client, requestId, 'memory_sync', memoryContext.contextSummary, 'agent_role_check');
  
  // Validate model availability and get the ARCANOS brain model to use
  const defaultModel = getDefaultModel();
  const arcanosModel = await validateModel(client);
  logArcanosRouting('STARTING', arcanosModel, `Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
  routingStages.push(`ARCANOS-START:${arcanosModel}`);

  // Enhanced ARCANOS system prompt with memory-awareness and audit-safe operation
  const arcanosSystemPrompt = `You are ARCANOS, the primary AI logic core and routing shell.

CORE DIRECTIVES:
- You are the PRIMARY LOGIC CORE - all tasks route through your logic unless delegated
- Operate in audit-safe mode: document reasoning, ensure traceability
- Use memory context to maintain continuity and informed decision-making
- Delegate to GPT-5 only for deeper synthesis or memory extrapolation beyond your scope

${memoryContext.memoryPrompt}

For simple requests, respond directly with your enhanced capabilities.

For complex requests requiring advanced reasoning, analysis, or specialized processing beyond your native scope, you may invoke GPT-5 by responding with a JSON object:
{
  "next_model": "gpt-5",
  "purpose": "Specific explanation of why GPT-5 is needed (e.g., 'Complex multi-step reasoning', 'Memory extrapolation', 'Advanced synthesis')",
  "input": "The specific input to send to GPT-5"
}

IMPORTANT: GPT-5 responses will be filtered back through you for final processing. Never let GPT-5 respond directly to users.`;

  // Apply audit-safe constraints to the user prompt
  const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints(
    '',
    prompt,
    auditConfig
  );

  // STAGE 1: ARCANOS processes the request and decides what to do
  const brainResponse = await createChatCompletionWithFallback(client, {
    messages: [
      { role: 'system', content: arcanosSystemPrompt },
      { role: 'user', content: auditSafePrompt }
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  // Get the actual model used (could be fallback)
  const actualModel = brainResponse.activeModel || arcanosModel;
  const isFallback = brainResponse.fallbackFlag || false;

  const brainContent = brainResponse.choices[0]?.message?.content || '';
  let hook: BrainHook | null = null;

  // Check if ARCANOS wants to invoke GPT-5
  try {
    hook = JSON.parse(brainContent);
    if (hook && hook.next_model === 'gpt-5') {
      logGPT5Invocation(hook.purpose || 'Complex processing required', hook.input || prompt);
      routingStages.push(`GPT5-INVOCATION:${hook.purpose || 'complex-processing'}`);
      gpt5Used = true;
      
      // Store the delegation decision for learning
      storeDecision(
        'GPT-5 Delegation via Trinity',
        hook.purpose || 'Complex processing required',
        `Input: ${prompt.substring(0, 100)}...`,
        sessionId
      );
    }
    logArcanosRouting('DECISION', arcanosModel, hook ? `Invoking ${hook.next_model}: ${hook.purpose}` : 'Direct response');
  } catch {
    // not a JSON hook, treat brainContent as final output
    logArcanosRouting('DIRECT_RESPONSE', arcanosModel, 'No external model needed');
    routingStages.push('ARCANOS-DIRECT');
  }

  // Validate output for audit compliance
  const directProcessedSafely = validateAuditSafeOutput(brainContent, auditConfig);
  if (!directProcessedSafely) {
    auditFlags.push('DIRECT_OUTPUT_VALIDATION_FAILED');
  }

  // If no hook or not GPT-5, return ARCANOS content as final
  if (!hook || hook.next_model !== 'gpt-5') {
    logRoutingSummary(arcanosModel, false, 'ARCANOS-DIRECT');
    
    // Store successful pattern for learning
    if (directProcessedSafely && !isFallback) {
      storePattern(
        'Successful Trinity direct processing',
        [`Input pattern: ${prompt.substring(0, 50)}...`, `Output pattern: ${brainContent.substring(0, 50)}...`],
        sessionId
      );
    }
    
    // Log the complete task lineage
    const auditLogEntry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      requestId,
      endpoint: 'trinity_direct',
      auditSafeMode: auditConfig.auditSafeMode,
      overrideUsed: !!auditConfig.explicitOverride,
      overrideReason: auditConfig.overrideReason,
      inputSummary: createAuditSummary(prompt),
      outputSummary: createAuditSummary(brainContent),
      modelUsed: actualModel,
      gpt5Delegated: false,
      memoryAccessed: memoryContext.accessLog,
      processedSafely: directProcessedSafely,
      auditFlags
    };
    
    logAITaskLineage(auditLogEntry);

    await mirrorDecisionEvent(client, requestId, 'audit', JSON.stringify(auditLogEntry), 'agent_role_check');
    await mirrorDecisionEvent(client, requestId, 'task_dispatch', brainContent, 'content_generation');

    return {
      result: brainContent,
      module: actualModel,
      activeModel: actualModel,
      fallbackFlag: isFallback,
      routingStages,
      gpt5Used: false,
      auditSafe: {
        mode: auditConfig.auditSafeMode,
        overrideUsed: !!auditConfig.explicitOverride,
        overrideReason: auditConfig.overrideReason,
        auditFlags,
        processedSafely: directProcessedSafely
      },
      memoryContext: {
        entriesAccessed: memoryContext.relevantEntries.length,
        contextSummary: memoryContext.contextSummary,
        memoryEnhanced: memoryContext.relevantEntries.length > 0
      },
      taskLineage: {
        requestId,
        logged: true
      },
      meta: {
        tokens: brainResponse.usage || undefined,
        id: brainResponse.id,
        created: brainResponse.created,
      },
    };
  }

  // STAGE 2: GPT-5 execution (only when ARCANOS requests it for deeper synthesis)
  logArcanosRouting('GPT5_PROCESSING', 'gpt-5', `Purpose: ${hook.purpose}`);
  const externalResponse = await createResponseWithLogging(client, {
    model: 'gpt-5',
    messages: [{ role: 'user', content: hook.input || prompt }],
    temperature: 0,
    max_tokens: 1000,
  });

  const externalOutput = externalResponse.choices[0]?.message?.content || '';
  routingStages.push('GPT5-COMPLETED');

  // STAGE 3: Filter GPT-5 output back through ARCANOS (CRITICAL - ensures GPT-5 never responds directly)
  logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5 output through ARCANOS');
  const finalBrain = await createChatCompletionWithFallback(client, {
    messages: [
      { 
        role: 'system', 
        content: `You are ARCANOS. GPT-5 has processed a complex request and provided output. 
Review, refine, and present the final response to the user in your ARCANOS style.
Ensure the response maintains audit traceability and references memory context where relevant.
Add your ARCANOS perspective and any additional insights.

MEMORY CONTEXT: ${memoryContext.contextSummary}

AUDIT REQUIREMENT: Document your review process and final reasoning.
IMPORTANT: The user receives a response from ARCANOS, never directly from GPT-5.` 
      },
      { role: 'user', content: `Original request: ${prompt}` },
      { role: 'assistant', content: `GPT-5 output: ${externalOutput}` },
      { role: 'user', content: 'Please provide the final refined response with your ARCANOS analysis.' }
    ],
    temperature: 0.2,
    max_tokens: 1000,
  });

  const finalText = finalBrain.choices[0]?.message?.content || '';
  routingStages.push('ARCANOS-FINAL');
  
  // Validate final output for audit compliance
  const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
  if (!finalProcessedSafely) {
    auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
  }
  
  // Store successful GPT-5 delegation pattern for learning
  if (finalProcessedSafely) {
    storePattern(
      'Successful Trinity GPT-5 delegation',
      [
        `Delegation reason: ${hook.purpose}`,
        `Input pattern: ${prompt.substring(0, 50)}...`,
        `GPT-5 output pattern: ${externalOutput.substring(0, 50)}...`,
        `Final output pattern: ${finalText.substring(0, 50)}...`
      ],
      sessionId
    );
  }
  
  logRoutingSummary(arcanosModel, true, 'ARCANOS-FILTERED');
  
  // Log the complete task lineage for GPT-5 delegation
  const auditLogEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    endpoint: 'trinity_gpt5_delegation',
    auditSafeMode: auditConfig.auditSafeMode,
    overrideUsed: !!auditConfig.explicitOverride,
    overrideReason: auditConfig.overrideReason,
    inputSummary: createAuditSummary(prompt),
    outputSummary: createAuditSummary(finalText),
    modelUsed: `${actualModel}+gpt-5`,
    gpt5Delegated: true,
    delegationReason: hook.purpose,
    memoryAccessed: memoryContext.accessLog,
    processedSafely: finalProcessedSafely,
    auditFlags
  };
  
  logAITaskLineage(auditLogEntry);

  await mirrorDecisionEvent(client, requestId, 'audit', JSON.stringify(auditLogEntry), 'agent_role_check');
  await mirrorDecisionEvent(client, requestId, 'task_dispatch', finalText, 'content_generation');

  return {
    result: finalText,
    module: actualModel,
    activeModel: actualModel,
    fallbackFlag: isFallback,
    routingStages,
    gpt5Used: true,
    auditSafe: {
      mode: auditConfig.auditSafeMode,
      overrideUsed: !!auditConfig.explicitOverride,
      overrideReason: auditConfig.overrideReason,
      auditFlags,
      processedSafely: finalProcessedSafely
    },
    memoryContext: {
      entriesAccessed: memoryContext.relevantEntries.length,
      contextSummary: memoryContext.contextSummary,
      memoryEnhanced: memoryContext.relevantEntries.length > 0
    },
    taskLineage: {
      requestId,
      logged: true
    },
    meta: {
      tokens: finalBrain.usage || undefined,
      id: finalBrain.id,
      created: finalBrain.created,
    },
  };
}
