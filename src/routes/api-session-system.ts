import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import {
  getSessionStorageBackendType,
  listSessions,
  readSession,
  replaySession,
  writeSession
} from '@services/sessionStorage.js';
import {
  SessionApiCreateResponseSchema,
  SessionApiHealthResponseSchema,
  SessionApiQueueDiagnosticsSchema,
  SessionApiReplayResponseSchema,
  SessionApiRouteTableResponseSchema,
  SessionApiSessionDetailSchema,
  SessionApiSessionListResponseSchema,
  SessionApiSessionSystemDiagnosticsSchema,
  SessionApiStorageDiagnosticsSchema,
  validateSessionApiPayload
} from '@services/sessionApiSchemas.js';
import {
  getQueueDiagnostics,
  getSessionSystemDiagnostics,
  getStorageDiagnostics
} from '@services/sessionSystemDiagnosticsService.js';
import { getCanonicalPublicRouteTable } from '@services/runtimeRouteTableService.js';
import { asyncHandler } from '@shared/http/index.js';
import { auditTrace } from '@transport/http/middleware/auditTrace.js';

const router = express.Router();

const createSessionSchema = z.object({
  label: z.string().trim().min(1).max(200),
  tag: z.string().trim().max(200).optional().nullable(),
  memoryType: z.string().trim().min(1).max(100),
  payload: z.unknown(),
  transcriptSummary: z.string().trim().max(10_000).optional().nullable()
});

const replaySessionSchema = z.object({
  version_number: z.number().int().positive().optional(),
  mode: z.string().trim().min(1).max(50).optional()
});

const listSessionQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().positive().max(100).optional()
});

const RESERVED_SESSION_ROUTE_SEGMENTS = new Set(['get', 'list', 'replay', 'save']);

router.use('/api/sessions', auditTrace);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveAuditTraceId(res: Response): string | null {
  const localsRecord = asRecord(res.locals);
  const traceId = localsRecord?.auditTraceId;
  return typeof traceId === 'string' && traceId.trim().length > 0 ? traceId.trim() : null;
}

function resolveBuildId(): string {
  return (
    process.env.RAILWAY_DEPLOYMENT_ID?.trim() ||
    process.env.RAILWAY_GIT_COMMIT_SHA?.trim() ||
    process.env.npm_package_version?.trim() ||
    'unknown'
  );
}

function resolveCanonicalSessionId(rawValue: unknown): string | null {
  if (typeof rawValue !== 'string') {
    return null;
  }

  const normalized = rawValue.trim();

  //audit Assumption: the canonical session API uses UUID session identifiers exclusively; failure risk: legacy alias segments like `/api/sessions/get` are misrouted as real session ids; expected invariant: only UUID route params are treated as session ids; handling strategy: reject reserved words and non-UUID values as missing routes.
  if (!normalized || RESERVED_SESSION_ROUTE_SEGMENTS.has(normalized.toLowerCase())) {
    return null;
  }

  return z.string().uuid().safeParse(normalized).success ? normalized : null;
}

function sendStructuredError(
  res: Response,
  statusCode: number,
  errorMessage: string,
  details?: string[]
): void {
  const payload: Record<string, unknown> = {
    error: errorMessage,
    code: statusCode
  };
  if (details && details.length > 0) {
    payload.details = details;
  }

  res.status(statusCode).json(payload);
}

function sendMissing(res: Response, errorMessage: string, statusCode = 404): void {
  sendStructuredError(res, statusCode, errorMessage);
}

function sendValidationFailure(res: Response, errorMessage: string, issues: string[]): void {
  sendStructuredError(res, 400, errorMessage, issues);
}

function sendValidatedJson<T>(
  res: Response,
  statusCode: number,
  payload: unknown,
  schema: z.ZodType<T>,
  schemaLabel: string
): void {
  res.status(statusCode).json(validateSessionApiPayload(schema, payload, schemaLabel));
}

/**
 * Canonical API health endpoint.
 *
 * Purpose:
 * - Return machine-verifiable process and deployment facts for the canonical public API contract.
 *
 * Inputs/outputs:
 * - Input: Express request.
 * - Output: JSON-only health snapshot.
 *
 * Edge case behavior:
 * - Route table length is derived from the currently mounted canonical route set.
 */
router.get('/api/health', asyncHandler(async (req, res) => {
  const routes = getCanonicalPublicRouteTable(req.app);

  sendValidatedJson(res, 200, {
    status: 'live',
    service: 'ARCANOS',
    buildId: resolveBuildId(),
    routeCount: routes.length,
    timestamp: new Date().toISOString()
  }, SessionApiHealthResponseSchema, 'SessionApiHealthResponse');
}));

/**
 * Canonical runtime route table endpoint.
 *
 * Purpose:
 * - Return the mounted canonical route surface derived from the live Express app.
 *
 * Inputs/outputs:
 * - Input: Express request.
 * - Output: JSON route table.
 *
 * Edge case behavior:
 * - Returns an empty list rather than inventing routes when introspection has no data.
 */
router.get('/api/health/routes', asyncHandler(async (req, res) => {
  sendValidatedJson(res, 200, {
    routes: getCanonicalPublicRouteTable(req.app),
    timestamp: new Date().toISOString()
  }, SessionApiRouteTableResponseSchema, 'SessionApiRouteTableResponse');
}));

/**
 * Canonical session-system diagnostics endpoint.
 *
 * Purpose:
 * - Return JSON-only infrastructure facts for the session API surface.
 *
 * Inputs/outputs:
 * - Input: Express request.
 * - Output: machine-verifiable session-system diagnostics.
 *
 * Edge case behavior:
 * - Status degrades automatically when storage, routes, or queue connectivity are unavailable.
 */
router.get('/api/diagnostics/session-system', asyncHandler(async (req, res) => {
  sendValidatedJson(
    res,
    200,
    await getSessionSystemDiagnostics(req.app),
    SessionApiSessionSystemDiagnosticsSchema,
    'SessionApiSessionSystemDiagnostics'
  );
}));

/**
 * Canonical queue diagnostics endpoint.
 *
 * Purpose:
 * - Return JSON-only queue health facts for audit and worker verification.
 *
 * Inputs/outputs:
 * - Input: Express request.
 * - Output: queue status snapshot.
 *
 * Edge case behavior:
 * - Returns explicit null job fields when no queue history is available.
 */
router.get('/api/diagnostics/queues', asyncHandler(async (_req, res) => {
  sendValidatedJson(
    res,
    200,
    await getQueueDiagnostics(),
    SessionApiQueueDiagnosticsSchema,
    'SessionApiQueueDiagnostics'
  );
}));

/**
 * Canonical storage diagnostics endpoint.
 *
 * Purpose:
 * - Return JSON-only PostgreSQL-backed storage facts for the session API.
 *
 * Inputs/outputs:
 * - Input: Express request.
 * - Output: storage status snapshot.
 *
 * Edge case behavior:
 * - Returns `offline` rather than inferred healthy state when the repository cannot query storage.
 */
router.get('/api/diagnostics/storage', asyncHandler(async (_req, res) => {
  sendValidatedJson(
    res,
    200,
    await getStorageDiagnostics(),
    SessionApiStorageDiagnosticsSchema,
    'SessionApiStorageDiagnostics'
  );
}));

/**
 * Canonical durable session-create endpoint.
 *
 * Purpose:
 * - Persist one new public session row and initial version snapshot in PostgreSQL.
 *
 * Inputs/outputs:
 * - Input: JSON body with `label`, `tag`, `memoryType`, and `payload`.
 * - Output: machine-verifiable create acknowledgement including UUID and storage backend.
 *
 * Edge case behavior:
 * - Validation failures return explicit JSON issues and no data is written.
 */
router.post('/api/sessions', asyncHandler(async (req, res) => {
  const parsedBody = createSessionSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    sendValidationFailure(
      res,
      'Invalid Session Create Payload',
      parsedBody.error.issues.map(issue => issue.message)
    );
    return;
  }

  try {
    const createdSession = await writeSession({
      label: parsedBody.data.label,
      tag: parsedBody.data.tag,
      memoryType: parsedBody.data.memoryType,
      payload: parsedBody.data.payload,
      transcriptSummary: parsedBody.data.transcriptSummary,
      auditTraceId: resolveAuditTraceId(res)
    });

    sendValidatedJson(res, 201, {
      id: createdSession.id,
      saved: true,
      storage: getSessionStorageBackendType(),
      createdAt: createdSession.createdAt
    }, SessionApiCreateResponseSchema, 'SessionApiCreateResponse');
  } catch (error: unknown) {
    //audit Assumption: durable save failures must never degrade to simulated success; failure risk: probe tests report persistence even when the transaction failed; expected invariant: failed writes return explicit storage errors; handling strategy: send a structured 500 response.
    sendStructuredError(res, 500, 'Session Save Failed', [resolveErrorMessage(error)]);
  }
}));

/**
 * Canonical durable session list endpoint.
 *
 * Purpose:
 * - Return the real PostgreSQL session catalog for the canonical API.
 *
 * Inputs/outputs:
 * - Input: optional `limit` and `q` query parameters.
 * - Output: JSON list with `items` and `total`.
 *
 * Edge case behavior:
 * - Validation failures return 400 JSON and do not hit storage.
 */
router.get('/api/sessions', asyncHandler(async (req, res) => {
  const parsedQuery = listSessionQuerySchema.safeParse(req.query ?? {});
  if (!parsedQuery.success) {
    sendValidationFailure(
      res,
      'Invalid Session List Query',
      parsedQuery.error.issues.map(issue => issue.message)
    );
    return;
  }

  try {
    const result = await listSessions({
      limit: parsedQuery.data.limit,
      search: parsedQuery.data.q ?? null
    });

    sendValidatedJson(res, 200, result, SessionApiSessionListResponseSchema, 'SessionApiSessionListResponse');
  } catch (error: unknown) {
    sendStructuredError(res, 500, 'Session List Failed', [resolveErrorMessage(error)]);
  }
}));

/**
 * Canonical durable session detail endpoint.
 *
 * Purpose:
 * - Return one DB-backed session row by UUID.
 *
 * Inputs/outputs:
 * - Input: session UUID route param.
 * - Output: JSON session detail with the exact stored payload.
 *
 * Edge case behavior:
 * - Non-UUID ids are treated as missing routes to prevent legacy alias ambiguity.
 */
router.get('/api/sessions/:id', asyncHandler(async (req, res) => {
  const sessionId = resolveCanonicalSessionId(req.params.id);
  if (!sessionId) {
    sendMissing(res, 'Route Not Found');
    return;
  }

  try {
    const session = await readSession(sessionId);
    if (!session) {
      sendMissing(res, 'Session Not Found');
      return;
    }

    sendValidatedJson(res, 200, session, SessionApiSessionDetailSchema, 'SessionApiSessionDetail');
  } catch (error: unknown) {
    sendStructuredError(res, 500, 'Session Retrieval Failed', [resolveErrorMessage(error)]);
  }
}));

/**
 * Canonical durable session replay endpoint.
 *
 * Purpose:
 * - Return one immutable historical session payload in safe-readonly mode.
 *
 * Inputs/outputs:
 * - Input: session UUID route param plus optional `version_number` and `mode` body fields.
 * - Output: JSON replay payload with exact historical payload data.
 *
 * Edge case behavior:
 * - Missing sessions or missing versions return explicit `status: missing` JSON.
 */
router.post('/api/sessions/:id/replay', asyncHandler(async (req, res) => {
  const sessionId = resolveCanonicalSessionId(req.params.id);
  if (!sessionId) {
    sendMissing(res, 'Route Not Found');
    return;
  }

  const parsedBody = replaySessionSchema.safeParse(req.body ?? {});
  if (!parsedBody.success) {
    sendValidationFailure(
      res,
      'Invalid Session Replay Payload',
      parsedBody.error.issues.map(issue => issue.message)
    );
    return;
  }

  try {
    const replay = await replaySession(sessionId, parsedBody.data.version_number);

    if (!replay) {
      sendMissing(res, 'Session Not Found');
      return;
    }

    sendValidatedJson(res, 200, replay, SessionApiReplayResponseSchema, 'SessionApiReplayResponse');
  } catch (error: unknown) {
    sendStructuredError(res, 500, 'Session Replay Failed', [resolveErrorMessage(error)]);
  }
}));

export default router;
