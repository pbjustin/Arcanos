import OpenAI from 'openai';
import { createResponseWithLogging, logArcanosRouting, logGPT5Invocation, logRoutingSummary } from '../utils/aiLogger.js';
import { getDefaultModel, createChatCompletionWithFallback, createGPT5Reasoning } from '../services/openai.js';
import {
  getAuditSafeConfig,
  applyAuditSafeConstraints,
  logAITaskLineage,
  validateAuditSafeOutput,
  createAuditSummary,
  type AuditLogEntry
} from '../services/auditSafe.js';
import { getMemoryContext, storePattern } from '../services/memoryAware.js';

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

// Check for the fine-tuned model, fallback to GPT-4 if unavailable
const validateModel = async (client: OpenAI) => {
  const defaultModel = getDefaultModel();
  try {
    const modelToCheck = defaultModel.startsWith('ft:') ? defaultModel : defaultModel;
    await client.models.retrieve(modelToCheck);
    console.log(`✅ Fine-tuned model ${defaultModel} is available`);
    return defaultModel;
  } catch (err) {
    console.warn(`⚠️  Model ${defaultModel} unavailable. Falling back to GPT-4.`);
    console.warn(`🔄 Fallback reason: ${err instanceof Error ? err.message : 'Unknown error'}`);
    return 'gpt-4';
  }
};

/**
 * Universal Trinity pipeline
 * ARCANOS Intake → GPT-5 Reasoning → ARCANOS Execution → Output
 * GPT-5 is always invoked as the primary reasoning stage.
 */
export async function runThroughBrain(
  client: OpenAI,
  prompt: string,
  sessionId?: string,
  overrideFlag?: string
): Promise<TrinityResult> {
  const requestId = `trinity_${Date.now()}_${Math.random().toString(36).substring(7)}`;

  const routingStages: string[] = [];
  const gpt5Used = true; // GPT-5 is now unconditional

  const auditConfig = getAuditSafeConfig(prompt, overrideFlag);
  console.log(`[🔒 TRINITY AUDIT-SAFE] Mode: ${auditConfig.auditSafeMode ? 'ENABLED' : 'DISABLED'}`);

  const memoryContext = getMemoryContext(prompt, sessionId);
  console.log(`[🧠 TRINITY MEMORY] Retrieved ${memoryContext.relevantEntries.length} relevant entries`);

  const arcanosModel = await validateModel(client);
  logArcanosRouting('INTAKE', arcanosModel, `Input length: ${prompt.length}, Memory entries: ${memoryContext.relevantEntries.length}, AuditSafe: ${auditConfig.auditSafeMode}`);
  routingStages.push(`ARCANOS-INTAKE:${arcanosModel}`);

  // Apply audit-safe constraints
  const { userPrompt: auditSafePrompt, auditFlags } = applyAuditSafeConstraints('', prompt, auditConfig);

  // ARCANOS intake prepares framed request for GPT-5
  const intakeSystemPrompt = `You are ARCANOS, the primary AI logic core. Integrate memory context and prepare the user's request for GPT-5 reasoning. Return only the framed request.\n\nMEMORY CONTEXT:\n${memoryContext.contextSummary}`;
  const intakeResponse = await createChatCompletionWithFallback(client, {
    messages: [
      { role: 'system', content: intakeSystemPrompt },
      { role: 'user', content: auditSafePrompt }
    ],
    temperature: 0.2,
    max_tokens: 500
  });
  const framedRequest = intakeResponse.choices[0]?.message?.content || auditSafePrompt;
  const actualModel = intakeResponse.activeModel || arcanosModel;
  const isFallback = intakeResponse.fallbackFlag || false;

  // GPT-5 reasoning stage (always invoked)
  logGPT5Invocation('Primary reasoning stage', framedRequest);
  routingStages.push('GPT5-REASONING');
  const gpt5Result = await createGPT5Reasoning(client, framedRequest, 'ARCANOS: Use GPT-5 for deep reasoning on every request. Return structured analysis only.');
  const gpt5Output = gpt5Result.content;

  // Final ARCANOS execution and filtering
  logArcanosRouting('FINAL_FILTERING', actualModel, 'Processing GPT-5 output through ARCANOS');
  routingStages.push('ARCANOS-FINAL');
  const finalResponse = await createChatCompletionWithFallback(client, {
    messages: [
      {
        role: 'system',
        content: `You are ARCANOS. GPT-5 has provided analysis which you must review, ensure safety, adjust tone, and deliver the final response.\n\nMEMORY CONTEXT: ${memoryContext.contextSummary}\nAUDIT REQUIREMENT: Document your final reasoning.`
      },
      { role: 'user', content: `Original request: ${auditSafePrompt}` },
      { role: 'assistant', content: `GPT-5 analysis: ${gpt5Output}` },
      { role: 'user', content: 'Provide the final ARCANOS response.' }
    ],
    temperature: 0.2,
    max_tokens: 1000
  });
  const finalText = finalResponse.choices[0]?.message?.content || '';

  const finalProcessedSafely = validateAuditSafeOutput(finalText, auditConfig);
  if (!finalProcessedSafely) {
    auditFlags.push('FINAL_OUTPUT_VALIDATION_FAILED');
  }

  if (finalProcessedSafely && !isFallback) {
    storePattern(
      'Successful Trinity pipeline',
      [
        `Input pattern: ${prompt.substring(0, 50)}...`,
        `GPT-5 output pattern: ${gpt5Output.substring(0, 50)}...`,
        `Final output pattern: ${finalText.substring(0, 50)}...`
      ],
      sessionId
    );
  }

  logRoutingSummary(arcanosModel, true, 'ARCANOS-FINAL');

  const auditLogEntry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    endpoint: 'trinity_gpt5_universal',
    auditSafeMode: auditConfig.auditSafeMode,
    overrideUsed: !!auditConfig.explicitOverride,
    overrideReason: auditConfig.overrideReason,
    inputSummary: createAuditSummary(prompt),
    outputSummary: createAuditSummary(finalText),
    modelUsed: `${actualModel}+gpt-5`,
    gpt5Delegated: true,
    memoryAccessed: memoryContext.accessLog,
    processedSafely: finalProcessedSafely,
    auditFlags
  };
  logAITaskLineage(auditLogEntry);

  return {
    result: finalText,
    module: actualModel,
    activeModel: actualModel,
    fallbackFlag: isFallback,
    routingStages,
    gpt5Used,
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
      tokens: finalResponse.usage || undefined,
      id: finalResponse.id,
      created: finalResponse.created
    }
  };
}
