/**
 * Shared request handling utilities for AI endpoints
 * Consolidates common error handling, validation, and response patterns
 */

import { Request, Response } from 'express';
import fs from 'fs';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';

export interface StandardAIRequest {
  prompt?: string;
  userInput?: string;
  content?: string;
  text?: string;
  query?: string;
  sessionId?: string;
  overrideAuditSafe?: string;
}

export interface StandardAIResponse {
  result: string;
  module?: string;
  endpoint?: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
  activeModel?: string;
  fallbackFlag?: boolean;
  error?: string;
}

export interface ErrorResponse {
  error: string;
  details?: string;
}

/**
 * Extract input text from various possible field names in request body
 */
export function extractInput(body: StandardAIRequest): string | null {
  return body.prompt || body.userInput || body.content || body.text || body.query || null;
}

/**
 * Validate and handle standard AI request preprocessing
 * Returns the OpenAI client if validation passes, null if mock response should be used
 */
export function validateAIRequest(
  req: Request<{}, any, StandardAIRequest>,
  res: Response<any>,
  endpointName: string
): { client: any; input: string } | null {
  console.log(`📨 /${endpointName} received`);
  
  const input = extractInput(req.body);
  
  if (!input || typeof input !== 'string') {
    res.status(400).json({ 
      error: `Missing or invalid input in request body. Use 'prompt', 'userInput', 'content', 'text', or 'query' field.`
    });
    return null;
  }

  // Check if we have a valid API key
  if (!hasValidAPIKey()) {
    console.log(`🤖 Returning mock response for /${endpointName} (no API key)`);
    const mockResponse = generateMockResponse(input, endpointName);
    res.json(mockResponse);
    return null;
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log(`🤖 Returning mock response for /${endpointName} (client init failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    res.json(mockResponse);
    return null;
  }

  return { client: openai, input };
}

/**
 * Handle errors in AI request processing with consistent error response format
 */
export function handleAIError(
  err: unknown,
  input: string,
  endpointName: string,
  res: Response<any>
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(`❌ ${endpointName} processing error:`, errorMessage);
  
  // Return mock response as fallback
  console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
  const mockResponse = generateMockResponse(input, endpointName);
  res.json({
    ...mockResponse,
    error: `AI service failure: ${errorMessage}`
  });
}

/**
 * Log request details for feedback and debugging (optional)
 */
export function logRequestFeedback(input: string, endpointName: string): void {
  try {
    const feedbackData = {
      timestamp: new Date().toISOString(),
      endpoint: endpointName,
      prompt: input.substring(0, 500) // Limit length for privacy
    };
    fs.writeFileSync('/tmp/last-gpt-request', JSON.stringify(feedbackData));
  } catch (error) {
    // Silently fail - feedback logging is not critical
    console.log('Could not write feedback file:', error instanceof Error ? error.message : 'Unknown error');
  }
}