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
 * Extract input text from various possible field names in request body.
 * Purpose: normalize request payloads that use alternate input keys.
 * Inputs/Outputs: accepts a validated AIRequestDTO and returns the first matching string or null.
 * Edge cases: returns null when all known input fields are missing or empty.
 */
export function extractInput(body: AIRequestDTO): string | null {
  //audit Assumption: request body may include multiple input fields; first non-empty wins. Risk: prioritization hides later fields. Invariant: return a string or null. Handling: short-circuit on first truthy field.
  return body.prompt || body.userInput || body.content || body.text || body.query || null;
}

/**
 * Validate and handle standard AI request preprocessing.
 * Purpose: enforce schema validation, provide mock fallback, and return the OpenAI client when available.
 * Inputs/Outputs: accepts Express request/response and endpoint name; returns client/input/body or null when handled.
 * Edge cases: missing body yields a 400 response; missing API key triggers mock response.
 */
export function validateAIRequest(
  req: Request<{}, AIResponseDTO | ErrorResponseDTO, AIRequestDTO>,
  res: Response<AIResponseDTO | ErrorResponseDTO>,
  endpointName: string
): { client: any; input: string; body: AIRequestDTO } | null {
  console.log(`📨 /${endpointName} received`);

  //audit Assumption: request body might be undefined or non-object. Risk: runtime crash on property access. Invariant: clientContext remains undefined unless body is object. Handling: guarded extraction.
  const clientContext =
    req.body && typeof req.body === 'object'
      ? (req.body as AIRequestDTO).clientContext
      : undefined;

  const parsed = aiRequestSchema.safeParse(req.body);
  //audit Assumption: payload must satisfy schema. Risk: malformed payload. Invariant: reject invalid payloads with 400. Handling: return detailed errors.
  if (!parsed.success) {
    const details = parsed.error.errors.map(err => `${err.path.join('.') || 'body'}: ${err.message}`);
    res.status(400).json({
      error: `Invalid request payload for ${endpointName}`,
      details
    });
    return null;
  }

  //audit Assumption: parsed data yields a single canonical input string. Risk: no input fields. Invariant: input must be non-empty string. Handling: 400 with guidance.
  const input = extractInput(parsed.data);

  if (!input || typeof input !== 'string') {
    res.status(400).json({
      error: `Missing or invalid input in request body. Use 'prompt', 'userInput', 'content', 'text', or 'query' field.`
    });
    return null;
  }

  // Check if we have a valid API key
  //audit Assumption: missing API key should use mock response. Risk: unintended real call without credentials. Invariant: when no key, return mock. Handling: short-circuit response.
  if (!hasValidAPIKey()) {
    console.log(`🤖 Returning mock response for /${endpointName} (no API key)`);
    const mockResponse = generateMockResponse(input, endpointName);
    res.json({ ...(mockResponse as AIResponseDTO), clientContext });
    return null;
  }

  const openai = getOpenAIClient();
  //audit Assumption: OpenAI client may fail to initialize. Risk: null client causing runtime errors. Invariant: fallback to mock response. Handling: return mock and stop.
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
 * Handle errors in AI request processing with consistent error response format.
 * Purpose: ensure failures return a structured mock response with error context.
 * Inputs/Outputs: accepts error, input, endpoint name, response; writes JSON response.
 * Edge cases: non-Error throwables are stringified for message clarity.
 */
export function handleAIError(
  err: unknown,
  input: string,
  endpointName: string,
  res: Response<AIResponseDTO | ErrorResponseDTO>
): void {
  //audit Assumption: errors may be non-Error types. Risk: losing error context. Invariant: errorMessage string always defined. Handling: stringify fallback.
  const errorMessage = err instanceof Error ? err.message : String(err);
  console.error(`❌ ${endpointName} processing error:`, errorMessage);
  
  // Return mock response as fallback
  //audit Assumption: returning mock response is acceptable on failure. Risk: masking upstream errors. Invariant: response includes error detail. Handling: attach error field.
  console.log(`🤖 Returning mock response for /${endpointName} (processing failed)`);
  const mockResponse = generateMockResponse(input, endpointName);
  res.json({
    ...mockResponse,
    error: `AI service failure: ${errorMessage}`
  } as AIResponseDTO & { error: string });
}

/**
 * Log request details for feedback and debugging (optional).
 * Purpose: persist a truncated prompt for local diagnostics.
 * Inputs/Outputs: accepts input and endpoint name; writes to /tmp or logs failure.
 * Edge cases: filesystem write errors are logged without interrupting request flow.
 */
export function logRequestFeedback(input: string, endpointName: string): void {
  try {
    //audit Assumption: writing to /tmp is permissible. Risk: permission/FS errors. Invariant: feedback data is JSON-serializable. Handling: catch and log errors.
    const feedbackData = {
      timestamp: new Date().toISOString(),
      endpoint: endpointName,
      prompt: input.substring(0, 500) // Limit length for privacy
    };
    //audit Assumption: feedback file path is safe. Risk: IO failure. Invariant: file contents are JSON string. Handling: throw to catch and log.
    fs.writeFileSync('/tmp/last-gpt-request', JSON.stringify(feedbackData));
  } catch (error) {
    //audit Assumption: logging failure is sufficient. Risk: losing diagnostics. Invariant: request flow continues. Handling: log error details.
    console.error('Could not write feedback file:', error instanceof Error ? error.message : 'Unknown error');
  }
}
