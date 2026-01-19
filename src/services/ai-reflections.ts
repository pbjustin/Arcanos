/**
 * AI Reflections Service for ARCANOS
 * Provides stateless reflection generation without memory dependencies
 */

import { callOpenAI, getDefaultModel } from './openai.js';
import { saveSelfReflection } from '../db/repositories/selfReflectionRepository.js';
import {
  AI_REFLECTION_DEFAULT_SYSTEM_PROMPT,
  buildReflectionPrompt,
  buildDefaultPatchContent,
  buildFallbackPatchContent
} from '../config/aiReflectionTemplates.js';
import { parseEnvInt, parseEnvFloat, parseEnvBoolean } from '../utils/envParsers.js';

const DEFAULT_REFLECTION_SYSTEM_PROMPT =
  process.env.AI_REFLECTION_SYSTEM_PROMPT || AI_REFLECTION_DEFAULT_SYSTEM_PROMPT;

export interface PatchSetOptions {
  useMemory?: boolean;
  priority?: 'low' | 'medium' | 'high';
  category?: string;
  systemAnalysis?: boolean;
  model?: string;
  tokenLimit?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  systemPrompt?: string;
  useCache?: boolean;
  aiMetadata?: Record<string, unknown>;
}

export interface PatchSet {
  content: string;
  priority: string;
  category: string;
  improvements: string[];
  metadata: {
    generated: string;
    useMemory: boolean;
    systemState?: any;
    modelUsed?: string;
    cached?: boolean;
    configuration?: {
      model: string;
      tokenLimit: number;
      temperature: number;
      topP: number;
      frequencyPenalty: number;
      presencePenalty: number;
      cache: boolean;
      systemPrompt: string;
    };
  };
}

async function persistSelfReflection(patch: PatchSet): Promise<void> {
  try {
    await saveSelfReflection({
      priority: patch.priority,
      category: patch.category,
      content: patch.content,
      improvements: patch.improvements,
      metadata: patch.metadata
    });
  } catch (error) {
    //audit Assumption: persistence failure should not stop execution; risk: losing audit trail; invariant: caller receives patch; handling: log warning and continue.
    console.warn(
      '[🧠 Reflections] Failed to persist self-reflection:',
      (error as Error).message
    );
  }
}

/**
 * Build a patch set with optional memory bypass.
 * Inputs: PatchSetOptions for model/config overrides.
 * Outputs: PatchSet describing reflection content and metadata.
 * Edge cases: falls back to templated content when AI call fails.
 */
export async function buildPatchSet(options: PatchSetOptions = {}): Promise<PatchSet> {
  const {
    useMemory = true,
    priority = 'medium',
    category = 'general',
    systemAnalysis = true
  } = options;

  const reflectionModel = options.model || process.env.AI_REFLECTION_MODEL || getDefaultModel();
  const tokenLimit = options.tokenLimit ?? parseEnvInt(process.env.AI_REFLECTION_TOKEN_LIMIT, 200);
  const temperature = options.temperature ?? parseEnvFloat(process.env.AI_REFLECTION_TEMPERATURE, 0.2);
  const topP = options.topP ?? parseEnvFloat(process.env.AI_REFLECTION_TOP_P, 1);
  const frequencyPenalty =
    options.frequencyPenalty ?? parseEnvFloat(process.env.AI_REFLECTION_FREQUENCY_PENALTY, 0);
  const presencePenalty =
    options.presencePenalty ?? parseEnvFloat(process.env.AI_REFLECTION_PRESENCE_PENALTY, 0);
  const systemPrompt = options.systemPrompt || DEFAULT_REFLECTION_SYSTEM_PROMPT;
  const useCache = options.useCache ?? parseEnvBoolean(process.env.AI_REFLECTION_CACHE, true);

  // If useMemory is false, bypass memory orchestration
  //audit Assumption: stateless mode should skip memory coordination; risk: reduced context; invariant: log when bypassing; handling: informational log.
  if (!useMemory) {
    console.log('🧠 Bypassing memory orchestration (stateless mode)');
  }

  const improvements = [];
  let systemState = null;

  try {
    // Generate AI-driven reflection content
    const memoryMode = useMemory ? 'enabled' : 'stateless';
    //audit Assumption: prompt template inputs are trusted; risk: prompt injection via inputs; invariant: string prompt; handling: use controlled values.
    const reflectionPrompt = buildReflectionPrompt({
      priority,
      category,
      memoryMode
    });

    const aiResponse = await callOpenAI(reflectionModel, reflectionPrompt, tokenLimit, useCache, {
      systemPrompt,
      temperature,
      top_p: topP,
      frequency_penalty: frequencyPenalty,
      presence_penalty: presencePenalty,
      metadata: {
        feature: 'ai-reflections',
        category,
        priority,
        useMemory,
        ...(options.aiMetadata || {})
      }
    });

    //audit Assumption: non-empty output indicates a successful AI response; risk: empty output treated as failure; invariant: improvements list tracks state; handling: gate on output.
    if (aiResponse.output) {
      improvements.push('AI-generated system analysis completed');
      //audit Assumption: cache flag drives success messaging; risk: mislabeling; invariant: message reflects cache state; handling: ternary selection.
      improvements.push(
        aiResponse.cached ? 'Reflection content retrieved from cache' : 'Reflection content generated successfully'
      );

      // Extract system state analysis if requested
      //audit Assumption: systemAnalysis toggles metadata creation; risk: missing state data; invariant: metadata matches flag; handling: conditional build.
      if (systemAnalysis) {
        systemState = {
          memoryMode,
          timestamp: new Date().toISOString(),
          aiModelUsed: aiResponse.model,
          category,
          priority
        };
        improvements.push('System state analysis performed');
      }
      improvements.push(`Reflection engine used model ${aiResponse.model}`);
    }

    // Build the patch content
    //audit Assumption: fallback template is acceptable when AI output missing; risk: less personalized content; invariant: content always set; handling: template fallback.
    const patchContent = aiResponse.output
      ? aiResponse.output
      : buildDefaultPatchContent({
          priority,
          category,
          memoryMode,
          generatedAt: new Date().toISOString()
        });

    const patch: PatchSet = {
      content: patchContent,
      priority,
      category,
      improvements,
      metadata: {
        generated: new Date().toISOString(),
        useMemory,
        systemState,
        modelUsed: aiResponse.model,
        cached: aiResponse.cached ?? false,
        configuration: {
          model: reflectionModel,
          tokenLimit,
          temperature,
          topP,
          frequencyPenalty,
          presencePenalty,
          cache: useCache,
          systemPrompt
        }
      }
    };

    await persistSelfReflection(patch);

    return patch;

  } catch (error: any) {
    //audit Assumption: AI call failures are recoverable; risk: missing AI insight; invariant: returns fallback patch; handling: log and return fallback.
    console.error('❌ Error generating patch set:', error.message);

    // Fallback patch set
    const fallbackTimestamp = new Date().toISOString();
    const fallbackMemoryMode = useMemory ? 'enabled' : 'stateless';
    const fallbackPatch: PatchSet = {
      content: buildFallbackPatchContent({
        priority,
        category,
        memoryMode: fallbackMemoryMode,
        generatedAt: fallbackTimestamp
      }),
      priority,
      category,
      improvements: ['Fallback patch generated', 'Error handling activated'],
      metadata: {
        generated: fallbackTimestamp,
        useMemory,
        //audit Assumption: reuse existing systemState when available; risk: losing error context; invariant: systemState always defined; handling: fallback object.
        systemState: systemState || {
          error: error.message,
          fallbackMode: true,
          aiModelUsed: reflectionModel
        },
        modelUsed: reflectionModel,
        cached: false,
        configuration: {
          model: reflectionModel,
          tokenLimit,
          temperature,
          topP,
          frequencyPenalty,
          presencePenalty,
          cache: useCache,
          systemPrompt
        }
      }
    };

    await persistSelfReflection(fallbackPatch);

    return fallbackPatch;
  }
}

/**
 * Generate reflection content for specific system components.
 * Inputs: component identifier, PatchSetOptions overrides.
 * Outputs: PatchSet scoped to the component.
 * Edge cases: inherits buildPatchSet fallback behavior.
 */
export async function generateComponentReflection(
  component: string,
  options: PatchSetOptions = {}
): Promise<PatchSet> {
  return buildPatchSet({
    ...options,
    category: `component-${component}`
  });
}

/**
 * Create a prioritized improvement queue.
 * Inputs: ordered priority list, PatchSetOptions overrides.
 * Outputs: PatchSet array in requested priority order.
 * Edge cases: sequential execution to preserve ordering.
 */
export async function createImprovementQueue(
  priorities: ('low' | 'medium' | 'high')[] = ['high', 'medium', 'low'],
  options: PatchSetOptions = {}
): Promise<PatchSet[]> {
  const queue = [];

  for (const priority of priorities) {
    //audit Assumption: sequential execution preserves priority ordering; risk: slower processing; invariant: queue ordered by priorities; handling: await per iteration.
    const patch = await buildPatchSet({
      ...options,
      priority
    });
    queue.push(patch);
  }

  return queue;
}
