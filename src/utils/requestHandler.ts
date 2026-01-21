/**
 * Shared request handling utilities for AI endpoints
 * Consolidates common error handling, validation, and response patterns
 */

import { Request, Response } from 'express';
import fs from 'fs';
import { getOpenAIClient, generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import {
  aiRequestSchema,
  type AIRequestDTO,
  type AIResponseDTO,
  type ErrorResponseDTO
} from '../types/dto.js';

/**
 * Extract input text from various possible field names in request body
 */
export function extractInput(body: AIRequestDTO): string | null {
  return body.prompt || body.userInput || body.content || body.text || body.query || null;
}

/**
 * Validate and handle standard AI request preprocessing
 * Returns the OpenAI client if validation passes, null if mock response should be used
 */
export function validateAIRequest(
  req: Request<{}, AIResponseDTO | ErrorResponseDTO, AIRequestDTO>,
  res: Response<AIResponseDTO | ErrorResponseDTO>,
  endpointName: string
): { client: any; input: string; body: AIRequestDTO } | null {
  console.log(`📨 /${endpointName} received`);

  const clientContext = (req.body as AIRequestDTO).clientContext;

  const parsed = aiRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    const details = parsed.error.errors.map(err => `${err.path.join('.') || 'body'}: ${err.message}`);
    res.status(400).json({
      error: `Invalid request payload for ${endpointName}`,
      details
    });
    return null;
  }

  const input = extractInput(parsed.data);

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
    res.json({ ...(mockResponse as AIResponseDTO), clientContext });
    return null;
  }

  const openai = getOpenAIClient();
  if (!openai) {
    console.log(`🤖 Returning mock response for /${endpointName} (client init failed)`);
    const mockResponse = generateMockResponse(input, endpointName);
    res.json({ ...(mockResponse as AIResponseDTO), clientContext });
    return null;
  }

  req.body = parsed.data;

  return { client: openai, input, body: parsed.data };
}

/**
 * Handle errors in AI request processing with consistent error response format
 */
export function handleAIError(
  err: unknown,
  input: string,
  endpointName: string,
  res: Response<AIResponseDTO | ErrorResponseDTO>
): void {
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(`❌ ${endpointName} processing error:`, errorMessage);
  
  // Return mock response as fallback
  console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
  const mockResponse = generateMockResponse(input, endpointName);
  res.json({
    ...mockResponse,
    error: `AI service failure: ${errorMessage}`
  } as AIResponseDTO & { error: string });
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