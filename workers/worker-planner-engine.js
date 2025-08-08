#!/usr/bin/env node
/**
 * Worker Planner Engine
 * Schedules planning cycles and context expansion
 */
import { createOpenAIClient, createCompletion } from './shared/workerUtils.js';
import { logEvent } from '../memory/logEvent.js';

export const id = 'worker-planner-engine';
export const description = 'Generates planning insights and expands context using OpenAI';

export async function run(input = {}) {
  const openai = createOpenAIClient();
  if (!openai) {
    throw new Error('Failed to initialize OpenAI client');
  }
  const completion = await createCompletion(
    openai,
    'You are ARCANOS planning engine. Provide next steps for system evolution.',
    input.query || 'Plan upcoming tasks and expand context for ARCANOS operations.',
    { max_tokens: 150, temperature: 0.2 }
  );
  await logEvent(id);
  return {
    success: true,
    result: completion.choices[0].message.content,
    worker: id,
    timestamp: new Date().toISOString()
  };
}
