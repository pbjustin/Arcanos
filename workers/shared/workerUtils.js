#!/usr/bin/env node
/**
 * Shared Worker Utilities - OpenAI SDK Compliant
 * Common patterns and utilities for ARCANOS workers
 */

import OpenAI from 'openai';

/**
 * Initialize OpenAI client with error handling
 */
export function createOpenAIClient() {
  try {
    return new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });
  } catch (error) {
    console.error('Failed to initialize OpenAI client:', error.message);
    return null;
  }
}

/**
 * Create standardized OpenAI completion request with retry logic
 */
export async function createCompletion(openai, systemPrompt, userPrompt, options = {}) {
  const defaultOptions = {
    model: process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2',
    max_tokens: 200,
    temperature: 0.2
  };

  const maxRetries = 3;
  let lastError;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await openai.chat.completions.create({
        ...defaultOptions,
        ...options,
        messages: [
          {
            role: 'system',
            content: systemPrompt
          },
          {
            role: 'user',
            content: userPrompt
          }
        ]
      });
    } catch (error) {
      lastError = error;
      console.error(`OpenAI completion attempt ${attempt} failed:`, error.message);
      
      if (attempt < maxRetries) {
        // Wait before retrying (exponential backoff)
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError;
}