import {
  Router,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod';

import { getRequestAuthenticatedActorKey } from '@platform/runtime/security.js';
import { answerQuestion, ingestContent, ingestUrl } from '@services/webRag.js';
import { asyncHandler } from '@shared/http/index.js';
import { ragHttpBoundary } from '@services/controlPlane/ragHttpBoundary.js';
import {
  ragBodyParser,
  sendInvalidRagRequest,
} from '@services/controlPlane/ragBodyParser.js';
import { confirmGate } from '@transport/http/middleware/confirmGate.js';
import type {
  ConfirmationChallengeBinding,
} from '@transport/http/middleware/confirmationChallengeStore.js';

export const RAG_MAX_URL_LENGTH = 2_048;
export const RAG_MAX_QUESTION_LENGTH = 4_000;
export const RAG_MAX_CONTENT_LENGTH = 200_000;
export const RAG_MAX_ID_LENGTH = 200;
export const RAG_MAX_METADATA_BYTES = 16 * 1024;
export const RAG_HTTP_CONCURRENCY_LIMIT = 2;

const RAG_MAX_SOURCE_LENGTH = 2_048;
const RAG_MAX_METADATA_DEPTH = 8;
const RAG_MAX_METADATA_NODES = 256;
const RAG_MAX_METADATA_ARRAY_LENGTH = 64;
const RAG_MAX_METADATA_KEY_LENGTH = 256;
const RAG_CONFIRMATION_WORKSPACE_ID = 'rag:control-plane';
const DANGEROUS_METADATA_KEYS = new Set([
  '__proto__',
  'prototype',
  'constructor',
]);
const validatedRagInput = Symbol('validatedRagInput');
let activeRagHttpOperations = 0;

type RagValidatedRequest = Request & {
  [validatedRagInput]?: unknown;
};

interface RagFetchInput {
  url: string;
}

interface RagSaveInput {
  id?: string;
  content: string;
  source?: string;
  metadata?: Record<string, unknown>;
}

interface RagQueryInput {
  question: string;
}

type RagHttpSlotResult<T> =
  | { status: 'completed'; value: T }
  | { status: 'busy' }
  | { status: 'closed' };

function isBoundedJsonMetadata(value: unknown): value is Record<string, unknown> {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
  ) {
    return false;
  }

  const seen = new Set<object>();
  let nodeCount = 0;
  const visit = (candidate: unknown, depth: number): boolean => {
    nodeCount += 1;
    if (nodeCount > RAG_MAX_METADATA_NODES || depth > RAG_MAX_METADATA_DEPTH) {
      return false;
    }
    if (
      candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
    ) {
      return true;
    }
    if (typeof candidate === 'number') {
      return Number.isFinite(candidate);
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) {
      return false;
    }

    const prototype = Object.getPrototypeOf(candidate);
    if (
      !Array.isArray(candidate)
      && prototype !== Object.prototype
      && prototype !== null
    ) {
      return false;
    }

    seen.add(candidate);
    const valid = Array.isArray(candidate)
      ? candidate.length <= RAG_MAX_METADATA_ARRAY_LENGTH
        && candidate.every((entry) => visit(entry, depth + 1))
      : Object.entries(candidate).every(([key, entry]) => (
        key.length <= RAG_MAX_METADATA_KEY_LENGTH
        && !DANGEROUS_METADATA_KEYS.has(key)
        && visit(entry, depth + 1)
      ));
    seen.delete(candidate);
    return valid;
  };

  try {
    return visit(value, 0)
      && Buffer.byteLength(JSON.stringify(value), 'utf8')
        <= RAG_MAX_METADATA_BYTES;
  } catch {
    return false;
  }
}

const ragUrlSchema = z.string()
  .max(RAG_MAX_URL_LENGTH)
  .superRefine((value, context) => {
    const trimmed = value.trim();
    if (!trimmed) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL is required.',
      });
      return;
    }
    try {
      const parsed = new URL(trimmed);
      if (
        (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
        || parsed.username
        || parsed.password
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'URL is invalid.',
        });
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'URL is invalid.',
      });
    }
  })
  .transform((value) => value.trim());

const ragFetchSchema = z.object({
  url: ragUrlSchema,
}).strict();

const ragSaveSchema = z.object({
  id: z.string()
    .max(RAG_MAX_ID_LENGTH)
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim())
    .optional(),
  content: z.string()
    .max(RAG_MAX_CONTENT_LENGTH)
    .refine((value) => value.trim().length > 0),
  source: z.string()
    .max(RAG_MAX_SOURCE_LENGTH)
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim())
    .optional(),
  metadata: z.custom<Record<string, unknown>>(isBoundedJsonMetadata, {
    message: 'Metadata is invalid.',
  }).optional(),
}).strict();

const ragQuerySchema = z.object({
  question: z.string()
    .max(RAG_MAX_QUESTION_LENGTH)
    .refine((value) => value.trim().length > 0)
    .transform((value) => value.trim()),
}).strict();

function validateRagBody<T>(schema: z.ZodType<T>): RequestHandler {
  return (req, res, next): void => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      sendInvalidRagRequest(req, res);
      return;
    }
    (req as RagValidatedRequest)[validatedRagInput] = result.data;
    next();
  };
}

function readValidatedRagInput<T>(req: Request): T {
  return (req as RagValidatedRequest)[validatedRagInput] as T;
}

function buildRagConfirmationBinding(
  req: Request,
  principalId: string
): ConfirmationChallengeBinding {
  return {
    actorKey: getRequestAuthenticatedActorKey(req),
    principalId,
    workspaceId: RAG_CONFIRMATION_WORKSPACE_ID,
  };
}

function requireRagIngestionConfirmation(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const principalId = req.controlPlanePrincipal?.principalId;
  if (!principalId) {
    req.logger?.warn?.('rag.confirmation_identity_unavailable', {
      requestId: req.requestId,
      traceId: req.traceId,
    });
    res.status(403).json({
      ok: false,
      error: {
        code: 'CONTROL_PLANE_FORBIDDEN',
        message: 'Control-plane operation is not permitted.',
      },
    });
    return;
  }

  // Challenge verification consumes a valid one-use token. Reject a saturated
  // confirmed retry synchronously first so its retryable 429 does not spend
  // approval; unconfirmed requests can still obtain their challenge. Express
  // then advances directly to runWithRagHttpSlot, whose immediate recheck and
  // increment occur before dependency work can yield.
  const confirmationHeader = req.get('x-confirmed')?.trim().toLowerCase();
  if (
    confirmationHeader?.startsWith('token:') === true
    && activeRagHttpOperations >= RAG_HTTP_CONCURRENCY_LIMIT
  ) {
    sendRagOperationBusy(req, res);
    return;
  }

  confirmGate(req, res, next, {
    challengeBinding: buildRagConfirmationBinding(req, principalId),
    requestFingerprintBody: req.body,
    requireChallengeToken: true,
  });
}

function isRagRequestClosed(req: Request, res: Response): boolean {
  return req.aborted
    || req.destroyed
    || res.destroyed
    || res.writableEnded;
}

async function runWithRagHttpSlot<T>(
  req: Request,
  res: Response,
  operation: () => Promise<T>
): Promise<RagHttpSlotResult<T>> {
  if (isRagRequestClosed(req, res)) {
    return { status: 'closed' };
  }
  if (activeRagHttpOperations >= RAG_HTTP_CONCURRENCY_LIMIT) {
    return { status: 'busy' };
  }
  activeRagHttpOperations += 1;

  try {
    if (isRagRequestClosed(req, res)) {
      return { status: 'closed' };
    }
    return {
      status: 'completed',
      value: await operation(),
    };
  } finally {
    activeRagHttpOperations = Math.max(0, activeRagHttpOperations - 1);
  }
}

function sendRagOperationBusy(req: Request, res: Response): void {
  req.logger?.warn?.('rag.operation_busy', {
    requestId: req.requestId,
    traceId: req.traceId,
  });
  res.setHeader('Retry-After', '5');
  res.status(429).json({
    ok: false,
    error: {
      code: 'RAG_OPERATION_BUSY',
      message: 'RAG operation capacity is temporarily unavailable.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

function sendRagOperationFailure(
  req: Request,
  res: Response,
  operation: 'fetch' | 'query' | 'save',
  error: unknown
): void {
  req.logger?.error?.('rag.operation_failed', {
    operation,
    requestId: req.requestId,
    traceId: req.traceId,
    errorType: error instanceof Error ? error.name : typeof error,
  });
  res.status(500).json({
    ok: false,
    error: {
      code: 'RAG_OPERATION_FAILED',
      message: 'RAG operation could not be completed.',
    },
    ...(req.requestId ? { requestId: req.requestId } : {}),
  });
}

const router = Router();

router.use('/rag', ragHttpBoundary, ragBodyParser);

router.post(
  '/rag/fetch',
  validateRagBody(ragFetchSchema),
  requireRagIngestionConfirmation,
  asyncHandler(async (req, res) => {
    const { url } = readValidatedRagInput<RagFetchInput>(req);
    try {
      const slotResult = await runWithRagHttpSlot(
        req,
        res,
        () => ingestUrl(url)
      );
      if (slotResult.status === 'busy') {
        sendRagOperationBusy(req, res);
        return;
      }
      if (slotResult.status === 'closed') {
        return;
      }
      const result = slotResult.value;
      res.json({
        id: result.parentId,
        parentId: result.parentId,
        url: result.source,
        chunkCount: result.chunkCount,
        contentLength: result.contentLength,
        metadata: result.metadata,
      });
    } catch (error) {
      sendRagOperationFailure(req, res, 'fetch', error);
    }
  })
);

router.post(
  '/rag/save',
  validateRagBody(ragSaveSchema),
  requireRagIngestionConfirmation,
  asyncHandler(async (req, res) => {
    const {
      id,
      content,
      source,
      metadata,
    } = readValidatedRagInput<RagSaveInput>(req);
    try {
      const slotResult = await runWithRagHttpSlot(
        req,
        res,
        () => ingestContent({
          id,
          content,
          source,
          metadata,
        })
      );
      if (slotResult.status === 'busy') {
        sendRagOperationBusy(req, res);
        return;
      }
      if (slotResult.status === 'closed') {
        return;
      }
      const result = slotResult.value;
      res.json({
        id: result.parentId,
        parentId: result.parentId,
        source: result.source,
        chunkCount: result.chunkCount,
        contentLength: result.contentLength,
        metadata: result.metadata,
      });
    } catch (error) {
      sendRagOperationFailure(req, res, 'save', error);
    }
  })
);

router.post(
  '/rag/query',
  validateRagBody(ragQuerySchema),
  asyncHandler(async (req, res) => {
    const { question } = readValidatedRagInput<RagQueryInput>(req);
    try {
      const slotResult = await runWithRagHttpSlot(
        req,
        res,
        () => answerQuestion(question)
      );
      if (slotResult.status === 'busy') {
        sendRagOperationBusy(req, res);
        return;
      }
      if (slotResult.status === 'closed') {
        return;
      }
      const result = slotResult.value;
      res.json(result);
    } catch (error) {
      sendRagOperationFailure(req, res, 'query', error);
    }
  })
);

export default router;
