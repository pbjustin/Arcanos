import express, { type NextFunction, type Request, type Response } from 'express';

import { createValidationMiddleware } from '@platform/runtime/security.js';
import { connectResearchBridge } from '@services/researchHub.js';
import { asyncHandler } from '@shared/http/index.js';
import { createClientDisconnectAbortScope } from '@shared/http/clientDisconnectAbort.js';
import {
  isResearchRequestValidationError,
  normalizeResearchHttpRequest,
} from '@shared/researchRequest.js';
import { buildValidationErrorResponse } from '@core/lib/errors/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

const researchSchema = {
  topic: {
    required: true,
    type: 'string' as const,
    minLength: 1,
  },
  urls: {
    required: false,
    type: 'array' as const,
  },
};

type ResearchRequestBody = {
  topic: string;
  urls?: unknown;
};

type ValidationErrorPayload = ReturnType<typeof buildValidationErrorResponse> & {
  success?: false;
};

interface CreateResearchRouterOptions {
  path: string;
  bridgeName: string;
  formatUrlValidationError?: (
    payload: ReturnType<typeof buildValidationErrorResponse>,
  ) => ValidationErrorPayload;
}

const defaultFormatUrlValidationError = (
  payload: ReturnType<typeof buildValidationErrorResponse>,
): ValidationErrorPayload => payload;

/**
 * Purpose: build a shared research route for regular and SDK surfaces.
 * Inputs/outputs: accepts the mount path, bridge identifier, and optional validation formatter; returns an Express router.
 * Edge case behavior: invalid `urls` payloads are rejected with a standardized validation response that callers may wrap for API-specific contracts.
 */
export function createResearchRouter(options: CreateResearchRouterOptions) {
  const router = express.Router();
  const researchBridge = connectResearchBridge(options.bridgeName);
  const formatUrlValidationError =
    options.formatUrlValidationError ?? defaultFormatUrlValidationError;
  const validateResearchContract = (
    req: Request<{}, unknown, ResearchRequestBody>,
    res: Response,
    next: NextFunction,
  ): void => {
    const { topic, urls = [] } = req.body;

    try {
      req.body = normalizeResearchHttpRequest({ topic, urls });
      next();
    } catch (error) {
      if (!isResearchRequestValidationError(error)) {
        throw error;
      }

      //audit Assumption: research limits are a public validation contract; risk: downstream amplification and confirmation-state churn; invariant: invalid requests stop before confirmation and bridge work; handling: standardized non-echoing 400.
      res
        .status(400)
        .json(
          formatUrlValidationError(
            buildValidationErrorResponse([error.message]),
          ),
        );
    }
  };

  router.post(
    options.path,
    createValidationMiddleware(researchSchema),
    validateResearchContract,
    confirmGate,
    asyncHandler(async (req: Request<{}, unknown, ResearchRequestBody>, res) => {
      const { topic, urls = [] } = req.body;
      const abortScope = createClientDisconnectAbortScope(
        req,
        res,
        'Research HTTP client disconnected',
      );
      let result: Awaited<ReturnType<typeof researchBridge.requestResearch>>;
      try {
        result = await abortScope.run(signal => researchBridge.requestResearch(
          {
            topic,
            urls: urls as string[],
          },
          { signal },
        ));
      } finally {
        abortScope.cleanup();
      }

      return res.json({
        success: true,
        ...result,
      });
    }),
  );

  return router;
}
