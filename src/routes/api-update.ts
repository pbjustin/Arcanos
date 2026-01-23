import express, { Request, Response } from 'express';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '../utils/security.js';
import { buildValidationErrorResponse } from '../utils/errorResponse.js';
import { aiLogger } from '../utils/structuredLogging.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import type { ErrorResponseDTO } from '../types/dto.js';

const router = express.Router();

router.use(securityHeaders);
router.use(createRateLimitMiddleware(60, 5 * 60 * 1000)); // 60 requests per 5 minutes

const MAX_DATA_SIZE = 10000; // 10KB max for update data

const updateValidationSchema = {
  updateType: { type: 'string' as const, required: true, minLength: 1, maxLength: 100, sanitize: true },
  data: { type: 'object' as const, required: true }
};

const updateValidation = createValidationMiddleware(updateValidationSchema);

interface UpdateRequest {
  updateType: string;
  data: Record<string, unknown>;
}

interface UpdateResponse {
  success: boolean;
}

router.post('/api/update', updateValidation, async (req: Request<{}, UpdateResponse | ErrorResponseDTO, UpdateRequest>, res: Response<UpdateResponse | ErrorResponseDTO>) => {
  try {
    const { updateType, data } = req.body;

    if (!updateType || typeof updateType !== 'string' || updateType.trim().length === 0) {
      return res.status(400).json(
        buildValidationErrorResponse(['updateType is required and must be a non-empty string'])
      );
    }

    if (data === undefined || data === null) {
      return res.status(400).json(
        buildValidationErrorResponse(['data is required'])
      );
    }

    // Validate data is JSON-serializable and within size limits
    let dataSize = 0;
    try {
      const serialized = JSON.stringify(data);
      dataSize = serialized.length;
    } catch (error) {
      return res.status(400).json(
        buildValidationErrorResponse(['data must be JSON-serializable'])
      );
    }

    if (dataSize > MAX_DATA_SIZE) {
      return res.status(413).json({
        error: 'Payload Too Large',
        message: `data exceeds maximum size of ${MAX_DATA_SIZE} bytes`,
        timestamp: new Date().toISOString()
      });
    }

    const normalizedUpdateType = updateType.trim();

    recordTraceEvent('update.event', {
      updateType: normalizedUpdateType,
      dataSize
    });

    aiLogger.info('Update event received', {
      operation: 'update',
      updateType: normalizedUpdateType,
      dataSize
    });

    // In a full implementation, you might persist this to a database or trigger other actions
    // For now, we just acknowledge receipt

    return res.json({
      success: true
    });
  } catch (error) {
    aiLogger.error('Update request failed', { operation: 'update' }, undefined, error as Error);
    recordTraceEvent('update.error', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });

    return res.status(500).json({
      error: 'Internal Server Error',
      message: 'Failed to process update request',
      timestamp: new Date().toISOString()
    });
  }
});

export default router;
