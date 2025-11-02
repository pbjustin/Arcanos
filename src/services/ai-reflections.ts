/**
 * AI Reflections Service for ARCANOS
 * Provides stateless reflection generation without memory dependencies
 */

import { callOpenAI, getDefaultModel } from './openai.js';

const DEFAULT_REFLECTION_SYSTEM_PROMPT =
  process.env.AI_REFLECTION_SYSTEM_PROMPT ||
  'You are the ARCANOS self-reflection engine. Provide concise, actionable improvement notes that help engineers iterate on the system.';

const parseEnvInt = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const parseEnvFloat = (value: string | undefined, fallback: number): number => {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? fallback : parsed;
};

const shouldUseCache = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['false', '0', 'off', 'no'].includes(normalized)) return false;
  if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  return fallback;
};

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

/**
 * Build a patch set with optional memory bypass
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
  const useCache = options.useCache ?? shouldUseCache(process.env.AI_REFLECTION_CACHE, true);

  // If useMemory is false, bypass memory orchestration
  if (!useMemory) {
    console.log('🧠 Bypassing memory orchestration (stateless mode)');
  }

  const improvements = [];
  let systemState = null;

  try {
    // Generate AI-driven reflection content
    const reflectionPrompt = `Generate a system improvement reflection for an AI system. 
    Priority level: ${priority}
    Category: ${category}
    Memory mode: ${useMemory ? 'enabled' : 'stateless'}
    
    Please provide:
    1. A brief analysis of current system state
    2. Specific improvement recommendations
    3. Implementation suggestions
    
    Keep the response concise and actionable.`;

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

    if (aiResponse.output) {
      improvements.push('AI-generated system analysis completed');
      improvements.push(
        aiResponse.cached ? 'Reflection content retrieved from cache' : 'Reflection content generated successfully'
      );

      // Extract system state analysis if requested
      if (systemAnalysis) {
        systemState = {
          memoryMode: useMemory ? 'enabled' : 'stateless',
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
    const patchContent = aiResponse.output
      ? aiResponse.output
      : `Automated system improvement patch (${priority} priority)
        
Category: ${category}
Memory mode: ${useMemory ? 'enabled' : 'stateless'}
Generated: ${new Date().toISOString()}

This patch represents an automated improvement to the ARCANOS system.
The changes are designed to enhance system performance and reliability.`;

    return {
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

  } catch (error: any) {
    console.error('❌ Error generating patch set:', error.message);

    // Fallback patch set
    return {
      content: `Fallback system improvement patch

Generated due to AI service unavailability.
Priority: ${priority}
Category: ${category}
Memory mode: ${useMemory ? 'enabled' : 'stateless'}
Timestamp: ${new Date().toISOString()}

This is a minimal fallback improvement patch that maintains system functionality
while providing basic enhancement capabilities.`,
      priority,
      category,
      improvements: ['Fallback patch generated', 'Error handling activated'],
      metadata: {
        generated: new Date().toISOString(),
        useMemory,
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
  }
}

/**
 * Generate reflection content for specific system components
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
 * Create a prioritized improvement queue
 */
export async function createImprovementQueue(
  priorities: ('low' | 'medium' | 'high')[] = ['high', 'medium', 'low'],
  options: PatchSetOptions = {}
): Promise<PatchSet[]> {
  const queue = [];
  
  for (const priority of priorities) {
    const patch = await buildPatchSet({
      ...options,
      priority
    });
    queue.push(patch);
  }
  
  return queue;
}