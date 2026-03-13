import express, { Request, Response } from 'express';
import { createValidationMiddleware, createRateLimitMiddleware } from "@platform/runtime/security.js";
import { asyncHandler, sendInternalErrorPayload } from '@shared/http/index.js';
import { buildTimestampedPayload } from "@transport/http/responseHelpers.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { routeGptRequest } from './_core/gptDispatch.js';
import type {
  CompletedSimulationResult,
  SimulationExecutionResult,
  StreamingSimulationResult
} from '@services/arcanos-sim.js';

const router = express.Router();
const SIMULATION_DISPATCH_GPT_ID = 'sim';

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

interface SimulationRouteParameters {
  temperature?: number;
  maxTokens?: number;
  max_tokens?: number;
  stream?: boolean;
}

interface SimulationRouteBody {
  scenario: string;
  context?: string;
  parameters?: SimulationRouteParameters;
}

function buildSimulationDispatcherBody(
  body: SimulationRouteBody
): {
  action: 'run';
  payload: SimulationRouteBody;
} {
  return {
    action: 'run',
    payload: {
      scenario: body.scenario,
      context: body.context,
      parameters: body.parameters
    }
  };
}

function isCompletedSimulationResult(
  value: unknown
): value is CompletedSimulationResult {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as SimulationExecutionResult).mode === 'complete' &&
    typeof (value as CompletedSimulationResult).result === 'string'
  );
}

function isStreamingSimulationResult(
  value: unknown
): value is StreamingSimulationResult {
  const streamCandidate =
    value && typeof value === 'object'
      ? (value as Partial<StreamingSimulationResult>).stream
      : undefined;

  return (
    !!value &&
    typeof value === 'object' &&
    (value as SimulationExecutionResult).mode === 'stream' &&
    !!streamCandidate &&
    typeof streamCandidate === 'object' &&
    Symbol.asyncIterator in streamCandidate
  );
}

async function sendSimulationStream(
  res: Response,
  result: StreamingSimulationResult
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  for await (const chunk of result.stream) {
    const content = chunk.choices[0]?.delta?.content || '';
    if (content) {
      res.write(`data: ${JSON.stringify({ content, type: 'chunk' })}\n\n`);
    }
  }

  res.write(`data: ${JSON.stringify({ type: 'done', metadata: result.metadata })}\n\n`);
  res.end();
}

/**
 * POST /api/sim - Run AI simulation scenarios
 * Provides RESTful JSON simulation capabilities using centralized ARCANOS model routing
 */
router.post('/', createValidationMiddleware(simulationSchema), asyncHandler(async (
  req: Request<{}, unknown, SimulationRouteBody>,
  res: Response
) => {
  const { scenario, context, parameters = {} } = req.body;

  try {
    const dispatchEnvelope = await routeGptRequest({
      gptId: SIMULATION_DISPATCH_GPT_ID,
      body: buildSimulationDispatcherBody({
        scenario,
        context,
        parameters
      }),
      requestId: req.requestId,
      logger: req.logger,
      request: req
    });

    //audit Assumption: `/api/sim` should surface dispatcher validation failures as client errors while preserving the legacy simulation envelope; failure risk: clients lose actionable error semantics after the dispatcher rewire; expected invariant: bad payloads return 400 and module/runtime faults remain 500-class errors; handling strategy: map dispatcher codes to the existing timestamped route contract.
    if (!dispatchEnvelope.ok) {
      const errorPayload = buildTimestampedPayload({
        status: 'error',
        message: 'Simulation failed',
        error: dispatchEnvelope.error.message
      });

      if (dispatchEnvelope.error.code === 'BAD_REQUEST') {
        return res.status(400).json(errorPayload);
      }

      sendInternalErrorPayload(res, errorPayload);
      return;
    }

    if (isStreamingSimulationResult(dispatchEnvelope.result)) {
      await sendSimulationStream(res, dispatchEnvelope.result);
      return;
    }

    //audit Assumption: dispatcher-backed simulation success should resolve to the standardized simulation result union; failure risk: route serializes an unrelated module payload and breaks clients; expected invariant: non-stream success contains `mode: complete`; handling strategy: validate the module result before formatting the HTTP response.
    if (!isCompletedSimulationResult(dispatchEnvelope.result)) {
      throw new Error('Simulation dispatcher returned an unexpected payload.');
    }

    res.json(buildTimestampedPayload({
      status: 'success',
      message: 'Simulation completed successfully',
      data: {
        scenario: dispatchEnvelope.result.scenario,
        result: dispatchEnvelope.result.result,
        metadata: dispatchEnvelope.result.metadata
      }
    }));

  } catch (error: unknown) {
    console.error('Simulation error:', resolveErrorMessage(error));

    //audit Assumption: simulation errors should return 500; risk: leaking internal details; invariant: response includes timestamp; handling: sanitize error message.
    sendInternalErrorPayload(res, buildTimestampedPayload({
      status: 'error',
      message: 'Simulation failed',
      error: resolveErrorMessage(error)
    }));
  }
}));

export default router;
