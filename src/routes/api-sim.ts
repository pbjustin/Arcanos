import express, { Request, Response } from 'express';
import { createCentralizedCompletion } from '../services/openai.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { createValidationMiddleware, createRateLimitMiddleware } from '../utils/security.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// Apply rate limiting globally
router.use(createRateLimitMiddleware(50, 15 * 60 * 1000)); // 50 requests per 15 minutes

/**
 * GET /api/sim/health - Check simulation service health
 */
router.get('/health', (_: Request, res: Response) => {
  res.json({
    status: 'success',
    message: 'Simulation service is operational',
    data: {
      service: 'ARCANOS Simulation API',
      version: '1.0.0',
      features: ['scenario_simulation', 'streaming_support', 'centralized_routing'],
      timestamp: new Date().toISOString()
    }
  });
});

/**
 * GET /api/sim/examples - Get simulation examples
 */
router.get('/examples', (_: Request, res: Response) => {
  res.json({
    status: 'success',
    message: 'Simulation examples retrieved',
    data: {
      examples: [
        {
          scenario: 'What would happen if AI systems became widespread in healthcare?',
          context: 'Consider current technological limitations and regulatory frameworks',
          parameters: { temperature: 0.7, maxTokens: 1500 }
        },
        {
          scenario: 'Simulate a software deployment scenario with potential failure modes',
          context: 'Enterprise environment with high availability requirements',
          parameters: { temperature: 0.5, maxTokens: 2000 }
        },
        {
          scenario: 'Model the economic impact of remote work adoption',
          context: 'Post-pandemic workplace transformation',
          parameters: { temperature: 0.6, maxTokens: 1800 }
        }
      ],
      timestamp: new Date().toISOString()
    }
  });
});

// Validation schema for simulation requests
const simulationSchema = {
  scenario: {
    required: true,
    type: 'string' as const,
    minLength: 10,
    maxLength: 1000,
    sanitize: true
  },
  context: {
    required: false,
    type: 'string' as const,
    maxLength: 2000,
    sanitize: true
  },
  parameters: {
    required: false,
    type: 'object' as const
  }
};

/**
 * POST /api/sim - Run AI simulation scenarios
 * Provides RESTful JSON simulation capabilities using centralized ARCANOS model routing
 */
router.post('/', createValidationMiddleware(simulationSchema), asyncHandler(async (req: Request, res: Response) => {
  const { scenario, context, parameters = {} } = req.body;

  try {
    // Construct simulation prompt
    const messages = [
      {
        role: 'user' as const,
        content: `Simulate the following scenario: ${scenario}${context ? `\n\nContext: ${context}` : ''}`
      }
    ];

    // Use centralized completion with ARCANOS routing
    const response = await createCentralizedCompletion(messages, {
      temperature: parameters.temperature || 0.8,
      max_tokens: parameters.maxTokens || 2048,
      stream: parameters.stream || false
    });

    // Handle streaming response
    if (parameters.stream && Symbol.asyncIterator in response) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });

      // Stream simulation results
      for await (const chunk of response as AsyncIterable<any>) {
        const content = chunk.choices[0]?.delta?.content || '';
        if (content) {
          res.write(`data: ${JSON.stringify({ content, type: 'chunk' })}\n\n`);
        }
      }
      
      res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
      res.end();
      return;
    }

    // Handle regular response
    const completion = response as any;
    const simulationResult = completion.choices[0]?.message?.content || '';

    res.json({
      status: 'success',
      message: 'Simulation completed successfully',
      data: {
        scenario,
        result: simulationResult,
        metadata: {
          model: completion.model,
          tokensUsed: completion.usage?.total_tokens || 0,
          timestamp: new Date().toISOString(),
          simulationId: generateRequestId('sim')
        }
      }
    });

  } catch (error) {
    console.error('Simulation error:', error);
    
    res.status(500).json({
      status: 'error',
      message: 'Simulation failed',
      error: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString()
    });
  }
}));

export default router;