import { Router, Request, Response } from 'express';
import { asyncHandler } from "@shared/http/index.js";
import { createValidationMiddleware, ValidationSchema } from "@platform/runtime/security.js";
import { sendServerError } from "@core/lib/errors/index.js";
import {
  generateReusableCodeSnippets,
  ReusableCodeGenerationRequest,
  ReusableCodeTarget
} from "@services/reusableCodeGeneration.js";
import { getOpenAIClientOrAdapter } from "@services/openai/clientBridge.js";
import { sendTimestampedServiceUnavailable } from "@platform/resilience/serviceUnavailable.js";

const router = Router();
const OPENAI_CODEGEN_SETUP_MESSAGE = 'Configure OPENAI_API_KEY or RAILWAY_OPENAI_API_KEY to enable code generation.';

const reusableCodeRequestSchema: ValidationSchema = {
  target: {
    required: false,
    type: 'string',
    allowedValues: ['all', 'asyncHandler', 'errorResponse', 'idGenerator']
  },
  includeDocs: {
    required: false,
    type: 'boolean'
  },
  language: {
    required: false,
    type: 'string',
    allowedValues: ['typescript']
  }
};

function sendCodegenServiceUnavailable(res: Response, reason: 'adapter' | 'client'): void {
  sendTimestampedServiceUnavailable(res, {
    error: reason === 'adapter' ? 'OpenAI adapter unavailable' : 'OpenAI client unavailable',
    message: OPENAI_CODEGEN_SETUP_MESSAGE
  });
}

function sendCodegenHealthUnavailable(res: Response, reason: 'adapter' | 'client'): void {
  sendTimestampedServiceUnavailable(res, {
    status: 'unavailable',
    message: reason === 'adapter' ? 'OpenAI adapter not initialized' : 'OpenAI client not initialized'
  });
}

/**
 * POST /api/reusables
 * Generates reusable utility code via the OpenAI SDK.
 *
 * @param req Express request with generation options.
 * @param res Express response with generated snippets.
 * @edgeCases Returns 503 when the OpenAI adapter is not configured.
 */
router.post(
  '/api/reusables',
  createValidationMiddleware(reusableCodeRequestSchema),
  asyncHandler(async (req: Request, res: Response) => {
    const { adapter } = getOpenAIClientOrAdapter();
    if (!adapter) {
      sendCodegenServiceUnavailable(res, 'adapter');
      return;
    }

    const requestBody = req.body as ReusableCodeGenerationRequest;
    const target = requestBody.target ?? 'all';
    const includeDocs = requestBody.includeDocs ?? true;
    const language = requestBody.language ?? 'typescript';

    const result = await generateReusableCodeSnippets(adapter, {
      target: target as ReusableCodeTarget,
      includeDocs,
      language
    });

    res.json({
      success: true,
      model: result.model,
      snippets: result.snippets
    });
  })
);

/**
 * GET /api/reusables/health
 * Lightweight endpoint to confirm availability of the reusables generator.
 *
 * @param _req Express request instance.
 * @param res Express response with status summary.
 * @edgeCases Returns 503 when the OpenAI adapter is not initialized.
 */
router.get('/api/reusables/health', (_req: Request, res: Response) => {
  const { adapter } = getOpenAIClientOrAdapter();
  if (!adapter) {
    sendCodegenHealthUnavailable(res, 'adapter');
    return;
  }

  res.json({
    status: 'ready',
    timestamp: new Date().toISOString()
  });
});

/**
 * Express error handler fallback for the reusable code generator.
 *
 * @param error Error instance raised in route handlers.
 * @param _req Express request instance.
 * @param res Express response instance.
 * @param _next Express next callback.
 * @edgeCases Handles unknown errors with a standardized payload.
 */
router.use((error: Error, _req: Request, res: Response, _next: () => void) => {
  //audit Assumption: error is safe to log; risk: leaking sensitive info; invariant: return generic message; handling: sendServerError.
  sendServerError(res, 'Reusable code generation failed', error);
});

export default router;
