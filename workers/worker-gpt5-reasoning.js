#!/usr/bin/env node
/**
 * ARCANOS GPT-5 Reasoning Worker
 * 
 * Handles GPT-5 reasoning delegation with database logging
 */

import { getOpenAIClient } from '../dist/services/openai.js';
import { logReasoning, logExecution, getStatus } from '../dist/db.js';
import { getTokenParameter } from '../dist/utils/tokenParameterHelper.js';

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
    const completion = await client.chat.completions.create({
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
  
  for (const [index, input] of inputs.entries()) {
    await logExecution(id, 'info', `Processing batch item ${index + 1}/${inputs.length}`);
    
    const result = await performReasoning(input, { 
      ...context, 
      batchIndex: index, 
      batchTotal: inputs.length 
    });
    
    results.push(result);
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