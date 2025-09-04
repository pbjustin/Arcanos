import express, { Request, Response } from 'express';
import { createCentralizedCompletion } from '../services/openai.js';
import { confirmGate } from '../middleware/confirmGate.js';
import { createValidationMiddleware, createRateLimitMiddleware } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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
  result?: any;
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
 * Minimal ARCANOS ask endpoint used by external services.
 * Uses centralized completion to ensure all requests pass through fine-tuned model.
 * Returns a success flag and the raw result from the centralized AI handler.
 * Includes simple ping/pong healthcheck functionality.
 */
router.post('/ask', confirmGate, createValidationMiddleware(arcanosSchema), asyncHandler(async (
  req: Request<{}, AskResponse, AskBody>,
  res: Response<AskResponse>
) => {
  try {
    const { prompt, options = {} } = req.body;

    // Simple ping/pong healthcheck - bypass AI processing for ping
    if (prompt.toLowerCase().trim() === 'ping') {
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

    // Use centralized completion to ensure ARCANOS routing
    const messages = [
      { role: 'user' as const, content: prompt }
    ];

    // Handle streaming response
    if (options.stream) {
      const response = await createCentralizedCompletion(messages, {
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
      for await (const chunk of response as AsyncIterable<any>) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          res.write(`data: ${JSON.stringify({ success: true, content, type: 'chunk' })}\n\n`);
        }
      }
      
      res.write(`data: ${JSON.stringify({ success: true, type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // Handle regular response
    const response = await createCentralizedCompletion(messages, {
      temperature: options.temperature || 0.7,
      max_tokens: options.max_tokens || 2048
    });

    const completion = response as any;
    const result = completion.choices[0]?.message?.content || '';

    return res.json({ 
      success: true, 
      result,
      metadata: {
        model: completion.model,
        tokensUsed: completion.usage?.total_tokens || 0,
        timestamp: new Date().toISOString(),
        arcanosRouting: true
      }
    });
  } catch (err: any) {
    console.error('ARCANOS API error:', err);
    
    // Enhanced error handling for network reachability and other issues
    const errorMessage = err.message || 'Unknown error occurred';
    
    // Check for common network/API related errors
    if (errorMessage.includes('ENOTFOUND') || errorMessage.includes('ECONNREFUSED')) {
      return res.status(503).json({ 
        success: false, 
        error: 'Network connectivity issue - unable to reach AI services'
      });
    }
    
    if (errorMessage.includes('timeout') || errorMessage.includes('ETIMEDOUT')) {
      return res.status(504).json({ 
        success: false, 
        error: 'Request timeout - AI service did not respond in time'
      });
    }

    if (errorMessage.includes('API key') || errorMessage.includes('unauthorized') || errorMessage.includes('401')) {
      return res.status(503).json({ 
        success: false, 
        error: 'AI service configuration issue - authentication failed'
      });
    }

    // Generic error fallback
    return res.status(500).json({ success: false, error: errorMessage });
  }
}));

export default router;

