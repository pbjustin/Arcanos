import express, { Request, Response } from 'express';
import OpenAI from 'openai';
import { createCentralizedCompletion } from '../services/openai.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createValidationMiddleware, createRateLimitMiddleware } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import type { IdleStateService } from '../services/idleStateService.js';

const router = express.Router();

// Apply rate limiting for API routes
router.use(createRateLimitMiddleware(100, 15 * 60 * 1000)); // 100 requests per 15 minutes

interface AskBody {
  prompt: string;
  options?: {
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
  };
}

interface AskResponse {
  success: boolean;
  result?: unknown;
  error?: string;
  metadata?: {
    service?: string;
    version?: string;
    model?: string;
    tokensUsed?: number;
    timestamp?: string;
    arcanosRouting?: boolean;
  };
}

// Validation schema for ARCANOS requests
const arcanosSchema = {
  prompt: {
    required: true,
    type: 'string' as const,
    minLength: 1,
    maxLength: 4000,
    sanitize: true
  },
  options: {
    required: false,
    type: 'object' as const
  }
};

/**
 * Validates that content is a non-empty string.
 * Inputs: unknown content and a source label for diagnostics.
 * Outputs: the original content string if valid.
 * Edge cases: throws for non-string or empty content to prevent invalid AI calls.
 */
function assertValidContent(input: unknown, source: string): string {
  //audit Assumption: upstream validation can be bypassed; risk: empty or non-string content; invariant: non-empty string; handling: throw with context.
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(
      `ARCANOS_SCHEMA_VIOLATION: 'content' must be a non-empty string (source=${source})`
    );
  }
  return input;
}

/**
 * Normalizes content for AI requests with a safe fallback.
 * Inputs: unknown content.
 * Outputs: trimmed content or a fallback marker string.
 * Edge cases: returns a sentinel string when input is empty or non-string.
 */
function normalizeContent(input: unknown): string {
  //audit Assumption: fallback is preferable to empty content; risk: degraded response quality; invariant: returns a string; handling: sentinel placeholder.
  if (typeof input === 'string' && input.trim().length > 0) {
    return input;
  }
  return '[ARCANOS:EMPTY_CONTENT_GUARD]';
}

/**
 * Builds the OpenAI chat messages array from a validated prompt.
 * Inputs: user prompt string.
 * Outputs: message array for OpenAI chat completion.
 * Edge cases: ensures content is always a string via normalization.
 */
function buildArcanosMessages(prompt: string) {
  //audit Assumption: system prompt is static; risk: prompt drift; invariant: message content is string; handling: normalize user content.
  return [
    {
      role: 'system' as const,
      content: 'You are ARCANOS, a logic-first operating intelligence.'
    },
    {
      role: 'user' as const,
      content: normalizeContent(prompt)
    }
  ];
}

/**
 * Creates the /ask handler with injected side-effect services.
 * Inputs: completion creator.
 * Outputs: Express handler for ARCANOS ask requests.
 * Edge cases: returns structured errors for invalid content or AI failures.
 */
function createArcanosAskHandler(deps: {
  createCompletion: typeof createCentralizedCompletion;
}) {
  const { createCompletion } = deps;
  return asyncHandler(async (
    req: Request<{}, AskResponse, AskBody>,
    res: Response<AskResponse>
  ) => {
    try {
      const { prompt: rawPrompt, options = {} } = req.body;
      //audit Assumption: options defaults to empty object; risk: undefined options; invariant: options is object; handling: default value.

      const prompt = assertValidContent(rawPrompt, 'REQUEST_BODY.prompt');

      // Simple ping/pong healthcheck - bypass AI processing for ping
      //audit Assumption: "ping" indicates user activity only; risk: false positives; invariant: ping refreshes idle timer; handling: record ping then respond.
      if (prompt.toLowerCase().trim() === 'ping') {
        const idleStateService = req.app.locals.idleStateService as IdleStateService | undefined;
        idleStateService?.noteUserPing({ route: '/ask', source: 'api-arcanos' });
        return res.json({
          success: true,
          result: 'pong',
          metadata: {
            service: 'ARCANOS API',
            version: '1.0.0',
            timestamp: new Date().toISOString()
          }
        });
      }

      const messages = buildArcanosMessages(prompt);

      //audit Assumption: message content must be string; risk: schema violation; invariant: every content is string; handling: throw before AI call.
      for (const message of messages) {
        if (typeof message.content !== 'string') {
          throw new Error('FATAL: message.content is not a string');
        }
      }

      // Handle streaming response
      //audit Assumption: stream option is boolean; risk: incorrect streaming path; invariant: stream true triggers SSE; handling: branch on options.stream.
      if (options.stream) {
        const response = await createCompletion(messages, {
          temperature: options.temperature || 0.7,
          max_tokens: options.max_tokens || 2048,
          stream: true
        });

        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*'
        });

        // Stream ARCANOS results
        for await (const chunk of response as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
          const content = chunk.choices[0]?.delta?.content || '';
          //audit Assumption: chunk delta may be empty; risk: noisy stream; invariant: only write non-empty content; handling: guard on content.
          if (content) {
            res.write(`data: ${JSON.stringify({ success: true, content, type: 'chunk' })}\n\n`);
          }
        }

        res.write(`data: ${JSON.stringify({ success: true, type: 'done' })}\n\n`);
        res.end();
        return;
      }

      // Handle regular response
      const response = await createCompletion(messages, {
        temperature: options.temperature || 0.7,
        max_tokens: options.max_tokens || 2048
      });

      //audit Assumption: non-stream responses are chat completions; risk: unexpected stream; invariant: chat completion structure; handling: throw.
      if (!isChatCompletion(response)) {
        throw new Error('Unexpected streaming response');
      }
      const result = response.choices[0]?.message?.content || '';

      return res.json({
        success: true,
        result,
        metadata: {
          model: response.model,
          tokensUsed: response.usage?.total_tokens || 0,
          timestamp: new Date().toISOString(),
          arcanosRouting: true
        }
      });
    } catch (err: unknown) {
      console.error('ARCANOS API error:', err instanceof Error ? err.message : err);

      const errorMessage = err instanceof Error ? err.message : 'Unknown error occurred';

      //audit Assumption: ENOTFOUND/ECONNREFUSED imply network failure; risk: misclassification; invariant: 503 on connectivity issue; handling: check message.
      if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
        return res.status(503).json({
          success: false,
          error: 'Network connectivity issue - unable to reach AI services'
        });
      }

      //audit Assumption: timeout strings imply upstream delay; risk: missed timeout types; invariant: 504 on timeout; handling: message check.
      if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
        return res.status(504).json({
          success: false,
          error: 'Request timeout - AI service did not respond in time'
        });
      }

      //audit Assumption: auth failures contain 401/unauthorized; risk: false positives; invariant: 503 with auth message; handling: message check.
      if (errorMessage.includes('API key') || errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
        return res.status(503).json({
          success: false,
          error: 'AI service configuration issue - authentication failed'
        });
      }

      //audit Assumption: unknown errors should surface; risk: leaking details; invariant: 500 with error message; handling: fallback.
      return res.status(500).json({ success: false, error: errorMessage });
    }
  });
}

/**
 * Minimal ARCANOS ask endpoint used by external services.
 * Uses centralized completion to ensure all requests pass through fine-tuned model.
 * Returns a success flag and the raw result from the centralized AI handler.
 * Includes simple ping/pong healthcheck functionality.
 */
const handleArcanosAsk = createArcanosAskHandler({
  createCompletion: createCentralizedCompletion
});

router.post('/ask', confirmGate, createValidationMiddleware(arcanosSchema), handleArcanosAsk);

// Test plan:
// - Happy path: valid prompt returns success and metadata.
// - Edge case: prompt is "ping" returns pong without AI call.
// - Failure modes: empty prompt triggers schema violation; upstream timeout returns 504.

export default router;

/**
 * Type guard for non-stream chat completions.
 * Inputs: completion response.
 * Outputs: boolean indicating chat completion shape.
 * Edge cases: returns false for streaming responses.
 */
function isChatCompletion(
  response: Awaited<ReturnType<typeof createCentralizedCompletion>>
): response is OpenAI.Chat.Completions.ChatCompletion {
  //audit Assumption: chat completion has choices property; risk: false positives; invariant: choices exists on chat completion; handling: property guard.
  return !!response && typeof response === 'object' && 'choices' in response;
}
