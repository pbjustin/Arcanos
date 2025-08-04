/**
 * AI Services - Main entry point for AI reflection and services
 * Exports reflect function for the AI Reflection Scheduler
 */

import { coreAIService } from '../ai-service-consolidated.js';
import { selfReflectionService } from '../self-reflection.js';
import { getNLPInterpreter } from '../../modules/nlp-interpreter.js';
import { saveMemory } from '../memory.js';
import type { ChatMessage } from '../unified-openai.js';

export interface ReflectionOptions {
  label: string;
  persist?: boolean;
  includeStack?: boolean;
  commitIfChanged?: boolean;
  targetPath?: string;
}

export interface ReflectionSnapshot {
  label: string;
  timestamp: string;
  reflection: string;
  systemState?: any;
  targetPath?: string;
  metadata: {
    model: string;
    persist: boolean;
    includeStack: boolean;
  };
}

/**
 * Perform AI self-reflection and return a snapshot
 * Compatible with OpenAI SDK patterns
 */
export async function reflect(options: ReflectionOptions): Promise<ReflectionSnapshot> {
  const {
    label,
    persist = false,
    includeStack = false,
    commitIfChanged = false,
    targetPath = 'ai_outputs/reflections/'
  } = options;

  const interpreter = getNLPInterpreter();
  const parsed = interpreter ? interpreter.parse(label) : { text: label } as any;
  const processedLabel = parsed.text;

  // Create reflection prompt
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: `You are performing a self-reflection as an AI system. Analyze your current state, recent interactions, and performance. Provide insights about:
      1. Current operational status
      2. Recent interactions and their outcomes
      3. Areas for improvement
      4. System health observations
      5. Any patterns or insights from recent activities
      
      Be concise but thorough. This reflection will be stored for long-term memory.`
    },
    {
      role: 'user',
      content: `Perform a self-reflection analysis. Current timestamp: ${new Date().toISOString()}`
    }
  ];

  // Get AI reflection
  const aiResponse = await coreAIService.complete(messages, 'self-reflection', {
    maxTokens: 2000,
    temperature: 0.3
  });

  // Gather system state if requested
  let systemState = undefined;
  if (includeStack) {
    systemState = {
      timestamp: new Date().toISOString(),
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      nodeVersion: process.version,
      platform: process.platform
    };
  }

  // Create reflection snapshot
  const snapshot: ReflectionSnapshot = {
    label: processedLabel,
    timestamp: new Date().toISOString(),
    reflection: aiResponse.content,
    systemState,
    targetPath,
    metadata: {
      model: aiResponse.model,
      persist,
      includeStack
    }
  };

  // Persist to reflection service if requested
  if (persist) {
    await selfReflectionService.saveSelfReflection(
      snapshot,
      processedLabel,
      `reflection_${Date.now()}`
    );

    // Also save to memory with the target path as key
    const memoryKey = `${targetPath}${processedLabel}`;
    await saveMemory(memoryKey, snapshot, 'reflections');
  }

  return snapshot;
}

// Re-export consolidated AI service for direct access
export { coreAIService } from '../ai-service-consolidated.js';