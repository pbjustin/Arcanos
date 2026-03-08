import express, { Request } from 'express';

import { createValidationMiddleware } from '@platform/runtime/security.js';
import { connectResearchBridge } from '@services/researchHub.js';
import { asyncHandler } from '@shared/http/index.js';
import { buildValidationErrorResponse } from '@core/lib/errors/index.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';

const researchSchema = {
  topic: {
    required: true,
    type: 'string' as const,
    minLength: 1,
    maxLength: 500,
    sanitize: true,
  },
  urls: {
    required: false,
    type: 'array' as const,
  },
};

type ResearchRequestBody = {
  topic: string;
  urls?: string[];
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

  router.post(
    options.path,
    confirmGate,
    createValidationMiddleware(researchSchema),
    asyncHandler(async (req: Request<{}, unknown, ResearchRequestBody>, res) => {
      const { topic, urls = [] } = req.body;

      if (!Array.isArray(urls) || urls.some(url => typeof url !== 'string')) {
        //audit Assumption: urls must be string array; risk: rejecting valid payloads; invariant: only strings allowed; handling: standardized validation error.
        return res
          .status(400)
          .json(
            formatUrlValidationError(
              buildValidationErrorResponse(["Field 'urls' must be an array of strings"]),
            ),
          );
      }

      const result = await researchBridge.requestResearch({ topic, urls });

      res.json({
        success: true,
        ...result,
      });
    }),
  );

  return router;
}
