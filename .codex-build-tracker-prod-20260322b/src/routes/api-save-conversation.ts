import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '@shared/http/index.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  loadConversationRecord,
  persistConversationRecord,
  type ConversationContentMode,
  type SaveConversationRecord,
  type SaveConversationRequest
} from '@services/saveConversationPersistence.js';

const router = express.Router();

const saveConversationRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  tags: z.array(z.string().trim().min(1).max(100)).max(25).optional(),
  storageType: z.string().trim().min(1).max(100).optional(),
  contentMode: z.enum(['transcript', 'summary']),
  content: z.unknown(),
  sessionId: z.string().trim().min(1).max(100).optional().nullable(),
  metadata: z.record(z.unknown()).optional().nullable()
});

const saveConversationSuccessSchema = z.object({
  success: z.literal(true),
  record_id: z.number().int().positive(),
  storage_type: z.string().min(1),
  title: z.string().min(1),
  tags: z.array(z.string()),
  content_mode: z.enum(['transcript', 'summary']),
  length_stored: z.number().int().nonnegative(),
  bytes_stored: z.number().int().nonnegative(),
  created_at: z.string().datetime(),
  error: z.null()
});

const saveConversationFailureSchema = z.object({
  success: z.literal(false),
  record_id: z.number().int().positive().nullable(),
  storage_type: z.string().nullable(),
  title: z.string().nullable(),
  tags: z.array(z.string()),
  content_mode: z.enum(['transcript', 'summary']).nullable(),
  length_stored: z.number().int().nonnegative(),
  bytes_stored: z.number().int().nonnegative(),
  created_at: z.string().datetime().nullable(),
  error: z.string().min(1)
});

const saveConversationRecordSchema = saveConversationSuccessSchema.extend({
  key: z.string().min(1),
  session_id: z.string().nullable(),
  updated_at: z.string().datetime(),
  content: z.unknown(),
  metadata: z.record(z.unknown()).nullable()
});

function sendValidatedPayload<T>(
  res: Response,
  statusCode: number,
  schema: z.ZodType<T>,
  payload: unknown,
  schemaLabel: string
): void {
  const parsedPayload = schema.safeParse(payload);

  //audit Assumption: this dedicated persistence endpoint must never emit ad hoc JSON because callers use it for deterministic automation; failure risk: partial success receipts look valid but omit required fields; expected invariant: every response matches its declared schema; handling strategy: fail closed when runtime payload validation fails.
  if (!parsedPayload.success) {
    throw new Error(`Invalid save-conversation payload for ${schemaLabel}`);
  }

  res.status(statusCode).json(parsedPayload.data);
}

function buildFailurePayload(params: {
  error: string;
  contentMode?: ConversationContentMode | null;
  recordId?: number | null;
  storageType?: string | null;
  title?: string | null;
}): z.infer<typeof saveConversationFailureSchema> {
  return {
    success: false,
    record_id: params.recordId ?? null,
    storage_type: params.storageType ?? null,
    title: params.title ?? null,
    tags: [],
    content_mode: params.contentMode ?? null,
    length_stored: 0,
    bytes_stored: 0,
    created_at: null,
    error: params.error
  };
}

/**
 * Persist one structured conversation payload with an immediate DB readback receipt.
 * Inputs/outputs: structured JSON request -> strict success/failure receipt.
 * Edge cases: read-after-write mismatches fail closed with `success:false`.
 */
router.post('/api/save-conversation', asyncHandler(async (req: Request, res: Response) => {
  const parsedRequest = saveConversationRequestSchema.safeParse(req.body ?? {});
  if (!parsedRequest.success) {
    return sendValidatedPayload(
      res,
      400,
      saveConversationFailureSchema,
      buildFailurePayload({
        error: parsedRequest.error.issues.map(issue => issue.message).join('; ')
      }),
      'SaveConversationFailure'
    );
  }

  try {
    const saveReceipt = await persistConversationRecord(parsedRequest.data as SaveConversationRequest);
    sendValidatedPayload(res, 201, saveConversationSuccessSchema, saveReceipt, 'SaveConversationSuccess');
  } catch (error: unknown) {
    //audit Assumption: persistence failures must return machine-verifiable failure receipts instead of transport-only errors; failure risk: clients cannot distinguish rejected writes from network faults; expected invariant: save failures keep the strict response envelope with `success:false`; handling strategy: convert exceptions into schema-validated failure payloads.
    sendValidatedPayload(
      res,
      500,
      saveConversationFailureSchema,
      buildFailurePayload({
        error: resolveErrorMessage(error),
        contentMode: parsedRequest.data.contentMode,
        storageType: parsedRequest.data.storageType ?? 'conversation',
        title: parsedRequest.data.title
      }),
      'SaveConversationFailure'
    );
  }
}));

/**
 * Fetch one previously saved structured conversation record by returned memory id.
 * Inputs/outputs: numeric record id route param -> strict stored record payload.
 * Edge cases: non-integer ids and missing rows return schema-validated failure payloads.
 */
router.get('/api/save-conversation/:recordId', asyncHandler(async (req: Request, res: Response) => {
  const parsedRecordId = Number.parseInt(String(req.params.recordId ?? ''), 10);
  if (!Number.isInteger(parsedRecordId) || parsedRecordId < 1) {
    return sendValidatedPayload(
      res,
      400,
      saveConversationFailureSchema,
      buildFailurePayload({
        error: 'recordId must be a positive integer.'
      }),
      'SaveConversationFailure'
    );
  }

  const storedRecord = await loadConversationRecord(parsedRecordId);
  if (!storedRecord) {
    return sendValidatedPayload(
      res,
      404,
      saveConversationFailureSchema,
      buildFailurePayload({
        error: `Conversation record ${parsedRecordId} was not found.`,
        recordId: parsedRecordId
      }),
      'SaveConversationFailure'
    );
  }

  sendValidatedPayload(
    res,
    200,
    saveConversationRecordSchema,
    storedRecord satisfies SaveConversationRecord,
    'SaveConversationRecord'
  );
}));

export default router;
