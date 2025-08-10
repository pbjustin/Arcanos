#!/usr/bin/env node
/**
 * ARCANOS GPT-5 Reasoning Worker
 * 
 * Handles GPT-5 reasoning delegation with database logging
 */

import { getOpenAIClient } from '../dist/services/openai.js';
import { logReasoning, logExecution, getStatus } from '../dist/db.js';
import { getTokenParameter } from '../dist/utils/tokenParameterHelper.js';

const API_TIMEOUT_MS = parseInt(process.env.WORKER_API_TIMEOUT_MS || '30000', 10);
const MAX_API_RETRIES = 3;
const MAX_ITERATIONS = 100;

async function safeChatCompletion(client, params) {
  for (let attempt = 1; attempt <= MAX_API_RETRIES; attempt++) {
    try {
      return await Promise.race([
        client.chat.completions.create(params),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('API request timed out')), API_TIMEOUT_MS)
        )
      ]);
    } catch (error) {
      await logExecution(id, 'error', `OpenAI chat completion failed (attempt ${attempt}): ${error.message}`);
      if (attempt === MAX_API_RETRIES) throw error;
    }
  }
}

export const id = 'worker-gpt5-reasoning';

/**
 * Perform GPT-5 reasoning and log results
 */
export async function performReasoning(input, context = {}) {
  const dbStatus = getStatus();
  
  try {
    await logExecution(id, 'info', 'Starting GPT-5 reasoning', { inputLength: input.length });
    
    const client = getOpenAIClient();
    if (!client) {
      const fallbackOutput = '[MOCK] GPT-5 reasoning simulation for: ' + input.substring(0, 100) + '...';
      
      // Log the reasoning attempt
      await logReasoning(input, fallbackOutput, { 
        mock: true, 
        reason: 'OpenAI client unavailable',
        context 
      });
      
      return fallbackOutput;
    }

    // Perform actual GPT-5 reasoning
    const systemPrompt = `You are GPT-5, a highly advanced reasoning engine. Provide deep, structured analysis and reasoning for the given input. Focus on:
1. Core analysis and understanding
2. Logical reasoning and inference
3. Structured conclusions
4. Actionable insights

Keep responses focused and valuable.`;

    const model = process.env.GPT5_MODEL || 'gpt-4o'; // Fallback to GPT-4o if GPT-5 not available
    const tokenParams = getTokenParameter(model, 2000);
    const completion = await safeChatCompletion(client, {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: input }
      ],
      ...tokenParams,
      temperature: 0.7
    });

    const output = completion.choices[0]?.message?.content || '[ERROR] No response generated';
    
    // Log the reasoning to database
    await logReasoning(input, output, { 
      model: completion.model,
      usage: completion.usage,
      context 
    });
    
    await logExecution(id, 'info', 'GPT-5 reasoning completed', { 
      outputLength: output.length,
      tokens: completion.usage?.total_tokens 
    });
    
    return output;
    
  } catch (error) {
    const errorOutput = `[ERROR] GPT-5 reasoning failed: ${error.message}`;
    
    await logExecution(id, 'error', 'GPT-5 reasoning failed', { 
      error: error.message,
      inputLength: input.length 
    });
    
    // Log the failed attempt
    await logReasoning(input, errorOutput, { 
      error: true, 
      errorMessage: error.message,
      context 
    });
    
    return errorOutput;
  }
}

/**
 * Batch reasoning for multiple inputs
 */
export async function performBatchReasoning(inputs, context = {}) {
  const results = [];
  let iterations = 0;

  for (const [index, input] of inputs.entries()) {
    if (iterations++ >= MAX_ITERATIONS) {
      await logExecution(id, 'warn', 'Max iteration limit reached in performBatchReasoning');
      break;
    }

    await logExecution(id, 'info', `Processing batch item ${index + 1}/${inputs.length}`);

    try {
      const result = await Promise.race([
        performReasoning(input, {
          ...context,
          batchIndex: index,
          batchTotal: inputs.length
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Job timed out')), API_TIMEOUT_MS)
        )
      ]);

      results.push(result);
    } catch (error) {
      await logExecution(id, 'error', `Batch reasoning failed: ${error.message}`, { index });
      results.push(`[ERROR] ${error.message}`);
    }
  }

  return results;
}

/**
 * Worker run function
 */
export async function run() {
  const dbStatus = getStatus();
  
  if (dbStatus.connected) {
    console.log('[🧠 WORKER-GPT5] ✅ Initialized with database reasoning logging');
  } else {
    console.log('[🧠 WORKER-GPT5] ⚠️  Initialized with fallback reasoning logging');
  }
  
  // Test OpenAI client availability
  const client = getOpenAIClient();
  const hasClient = !!client;
  
  // Log initial startup
  try {
    await logExecution(id, 'info', 'GPT-5 reasoning worker initialized', { 
      database: dbStatus.connected,
      openaiClient: hasClient,
      model: process.env.GPT5_MODEL || 'gpt-4o'
    });
  } catch (error) {
    console.log('[🧠 WORKER-GPT5] Startup logging failed, using fallback');
  }
  
  if (!hasClient) {
    console.log('[🧠 WORKER-GPT5] ⚠️  OpenAI client not available - will use mock responses');
  }
}

console.log(`[🧠 WORKER-GPT5] Module loaded: ${id}`);