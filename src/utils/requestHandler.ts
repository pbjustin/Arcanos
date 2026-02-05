/**
 * Shared request handling utilities for AI endpoints
 * Consolidates common error handling, validation, and response patterns
 */

import type OpenAI from 'openai';
import { Request, Response } from 'express';
import fs from 'fs';
import { generateMockResponse, hasValidAPIKey } from '../services/openai.js';
import { getOpenAIClientOrAdapter } from '../services/openai/clientBridge.js';
import {
  aiRequestSchema,
  type AIRequestDTO,
  type AIResponseDTO,
  type ErrorResponseDTO
} from '../types/dto.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

/**
 * Extract input text from various possible field names in request body
 */
export function extractInput(body: AIRequestDTO): string | null {
  //audit Assumption: known fields cover all input variants; Handling: first match
  return body.prompt || body.userInput || body.content || body.text || body.query || null;
}

export function createMockAIResponse(
  input: string,
  endpointName: string,
  options: {
    clientContext?: AIRequestDTO['clientContext'];
    error?: string;
  } = {}
): AIResponseDTO {
  const mockResponse = generateMockResponse(input, endpointName) as AIResponseDTO;
  return {
    ...mockResponse,
    ...(options.clientContext ? { clientContext: options.clientContext } : {}),
    ...(options.error ? { error: options.error } : {})
  };
}

export function sendMockAIResponse<T extends AIResponseDTO | ErrorResponseDTO>(
  res: Response<T>,
  input: string,
  endpointName: string,
  reason: string,
  options: {
    clientContext?: AIRequestDTO['clientContext'];
    error?: string;
  } = {}
): null {
  console.log(`🤖 Returning mock response for /${endpointName} (${reason})`);
  const payload = createMockAIResponse(input, endpointName, options);
  res.json(payload as T);
  return null;
}

export function sendAIStatusError<T extends { success: boolean; error?: string }>(
  res: Response<T>,
  statusCode: number,
  error: string
): null {
  res.status(statusCode).json({
    success: false,
    error
  } as T);
  return null;
}

/**
 * Validate and handle standard AI request preprocessing
 * Returns the OpenAI client if validation passes, null if mock response should be used
 */
export function validateAIRequest(
  req: Request<{}, AIResponseDTO | ErrorResponseDTO, AIRequestDTO>,
  res: Response<AIResponseDTO | ErrorResponseDTO>,
  endpointName: string
): { client: OpenAI; input: string; body: AIRequestDTO } | null {
  console.log(`📨 /${endpointName} received`);

  const clientContext = (req.body as AIRequestDTO).clientContext;

  const parsed = aiRequestSchema.safeParse(req.body);
  //audit Assumption: schema failure should return 400; Handling: error response
  if (!parsed.success) {
    const details = parsed.error.errors.map(err => `${err.path.join('.') || 'body'}: ${err.message}`);
    res.status(400).json({
      error: `Invalid request payload for ${endpointName}`,
      details
    });
    return null;
  }

  const input = extractInput(parsed.data);

  //audit Assumption: input must be a non-empty string; Handling: validation fail
  if (!input || typeof input !== 'string') {
    res.status(400).json({
      error: `Missing or invalid input in request body. Use 'prompt', 'userInput', 'content', 'text', or 'query' field.`
    });
    return null;
  }

  // Check if we have a valid API key
  //audit Assumption: missing API key should trigger mock path; Handling: fallback
  if (!hasValidAPIKey()) {
    return sendMockAIResponse(res, input, endpointName, 'no API key', { clientContext });
  }

  const { adapter, client: openai } = getOpenAIClientOrAdapter();

  if (!adapter) {
    return sendMockAIResponse(res, input, endpointName, 'adapter init failed', { clientContext });
  }

  //audit Assumption: client init failure should return mock response; Handling: fallback
  if (!openai) {
    return sendMockAIResponse(res, input, endpointName, 'client init failed', { clientContext });
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
  //audit Assumption: error message should be safely derived; Handling: stringify
  const errorMessage = resolveErrorMessage(err);
  console.error(`❌ ${endpointName} processing error:`, errorMessage);
  //audit Assumption: mock response is acceptable fallback; Handling: include error
  sendMockAIResponse(res, input, endpointName, 'processing failed', {
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
  } catch (error: unknown) {
    //audit Assumption: feedback logging failures should not break request; Handling: log only
    console.log('Could not write feedback file:', resolveErrorMessage(error));
  }
}
