import express, { type Request, type Response } from 'express';
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { getUserSessionDetail, listUserSessions } from "@services/sessionCatalogService.js";
import { asyncHandler, sendBadRequest, sendInternalErrorPayload } from '@shared/http/index.js';
import { auditTrace } from "@transport/http/middleware/auditTrace.js";
import { handleReplayRequest } from './ask/replay.js';

const router = express.Router();

router.use('/api/sessions', auditTrace);

/**
 * Resolve and bound a numeric session list limit from query parameters.
 * Inputs/outputs: raw query value -> positive integer limit or undefined for service default.
 * Edge cases: invalid values defer to the service default.
 */
function resolveSessionListLimit(rawLimit: unknown): number | undefined {
  const firstValue = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
  const parsedLimit = Number.parseInt(
    typeof firstValue === 'string' || typeof firstValue === 'number' ? String(firstValue) : '',
    10
  );

  //audit Assumption: invalid UI list limits should not fail the endpoint; failure risk: harmless client noise causes avoidable 400 responses; expected invariant: list requests always fall back to a bounded default; handling strategy: return undefined so the service applies its default clamp.
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    return undefined;
  }

  return parsedLimit;
}

/**
 * Normalize optional session search text from query parameters.
 * Inputs/outputs: raw query value -> trimmed search string or null.
 * Edge cases: empty values disable filtering.
 */
function resolveSessionListSearch(rawSearch: unknown): string | null {
  const firstValue = Array.isArray(rawSearch) ? rawSearch[0] : rawSearch;
  if (typeof firstValue !== 'string') {
    return null;
  }

  const normalized = firstValue.trim();
  return normalized.length > 0 ? normalized : null;
}

/**
 * Normalize a path-derived session identifier.
 * Inputs/outputs: raw route param -> trimmed bounded session id or null.
 * Edge cases: blank values are rejected as client errors.
 */
function resolveRouteSessionId(rawSessionId: unknown): string | null {
  if (typeof rawSessionId !== 'string') {
    return null;
  }

  const normalized = rawSessionId.trim();
  return normalized.length > 0 ? normalized.slice(0, 100) : null;
}

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

function recordSessionApiTraceEvent(
  name: string,
  req: Request,
  res: Response,
  attributes: Record<string, unknown>
): void {
  recordTraceEvent(name, {
    traceId: resolveAuditTraceId(res),
    method: req.method,
    path: req.path,
    ...attributes
  });
}

router.get('/api/sessions', asyncHandler(async (req, res) => {
  const limit = resolveSessionListLimit(req.query.limit);
  const search = resolveSessionListSearch(req.query.q);

  recordSessionApiTraceEvent('sessions.api.list.requested', req, res, {
    limit: limit ?? 'default',
    search
  });

  try {
    const sessions = await listUserSessions({ limit, search });

    recordSessionApiTraceEvent('sessions.api.list.succeeded', req, res, {
      count: sessions.length,
      search
    });

    res.json({
      status: 'success',
      message: 'Sessions retrieved',
      traceId: resolveAuditTraceId(res),
      data: {
        count: sessions.length,
        sessions
      }
    });
  } catch (error: unknown) {
    //audit Assumption: session list failures must stay observable for operators and API clients; failure risk: placeholder behavior or opaque 500s mask a broken cache/persistence layer; expected invariant: list failures emit trace context and return a normalized error payload; handling strategy: record a failure event and send a structured internal error response.
    recordSessionApiTraceEvent('sessions.api.list.failed', req, res, {
      search,
      error: resolveErrorMessage(error)
    });

    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Session list retrieval failed',
      traceId: resolveAuditTraceId(res),
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}));

router.get('/api/sessions/replay', asyncHandler(handleReplayRequest));
router.post('/api/sessions/replay', asyncHandler(handleReplayRequest));

router.get('/api/sessions/:sessionId', asyncHandler(async (req, res) => {
  const sessionId = resolveRouteSessionId(req.params.sessionId);

  //audit Assumption: session detail APIs must target one explicit session; failure risk: ambiguous lookups or accidental broad scans; expected invariant: route param always resolves to one bounded non-empty session id; handling strategy: reject blank identifiers before touching storage.
  if (!sessionId) {
    recordSessionApiTraceEvent('sessions.api.detail.rejected', req, res, {
      reason: 'missing-session-id'
    });
    sendBadRequest(res, 'SESSION_ID_REQUIRED', ['sessionId is required']);
    return;
  }

  try {
    const session = await getUserSessionDetail(sessionId);
    if (!session) {
      recordSessionApiTraceEvent('sessions.api.detail.not_found', req, res, {
        sessionId
      });

      res.status(404).json({
        status: 'error',
        message: 'Session not found',
        traceId: resolveAuditTraceId(res),
        data: {
          sessionId
        },
        timestamp: new Date().toISOString()
      });
      return;
    }

    recordSessionApiTraceEvent('sessions.api.detail.succeeded', req, res, {
      sessionId,
      messageCount: session.messageCount,
      replayable: session.replayable,
      droppedMessageCount: session.droppedMessageCount
    });

    res.json({
      status: 'success',
      message: 'Session retrieved',
      traceId: resolveAuditTraceId(res),
      data: {
        session
      }
    });
  } catch (error: unknown) {
    //audit Assumption: session detail retrieval failures must remain observable and deterministic; failure risk: silent 500s erase auditability for session restore incidents; expected invariant: failures emit telemetry and return a normalized error payload; handling strategy: record trace context and send a structured internal error response.
    recordSessionApiTraceEvent('sessions.api.detail.failed', req, res, {
      sessionId,
      error: resolveErrorMessage(error)
    });

    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Session retrieval failed',
      traceId: resolveAuditTraceId(res),
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}));

router.get('/api/sessions/:sessionId/replay', asyncHandler(handleReplayRequest));
router.post('/api/sessions/:sessionId/replay', asyncHandler(handleReplayRequest));

export default router;
