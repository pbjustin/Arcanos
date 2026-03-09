import type { Request, Response } from 'express';
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { getConversation } from "@services/sessionMemoryService.js";
import { recordTraceEvent } from "@platform/logging/telemetry.js";
import { buildSessionReplayRestoreState } from "@services/sessionReplayStateService.js";
import { sendBadRequest, sendInternalErrorPayload } from '@shared/http/index.js';

const replayLogger = logger.child({ module: 'askReplayRoute' });
const DEFAULT_REPLAY_LIMIT = 100;
const MAX_REPLAY_LIMIT = 500;

interface ReplayRequestState {
  sessionId: string;
  limit: number;
}

interface ReplayTurn {
  index: number;
  role: string;
  content: string;
  timestamp: number | string | null;
  meta: Record<string, unknown>;
}

/**
 * Extract the unified request payload source for replay endpoints.
 * Inputs/outputs: Express request -> sanitized query/body record.
 * Edge cases: non-object payloads degrade to an empty record.
 */
function resolveReplaySource(req: Request): Record<string, unknown> {
  const source = req.method === 'GET' ? req.query : req.body;
  if (!source || typeof source !== 'object') {
    return {};
  }

  return source as Record<string, unknown>;
}

/**
 * Normalize the replay session identifier from a request payload.
 * Inputs/outputs: raw request value -> trimmed session id or null.
 * Edge cases: array values use the first item; empty/non-string values are rejected.
 */
function resolveReplaySessionId(rawSessionId: unknown): string | null {
  const firstValue = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  if (typeof firstValue !== 'string') {
    return null;
  }

  const normalized = firstValue.trim();
  if (!normalized) {
    return null;
  }

  return normalized.slice(0, 100);
}

/**
 * Resolve an optional replay limit with bounded defaults.
 * Inputs/outputs: raw request value -> positive integer limit.
 * Edge cases: invalid or oversized values fall back to the configured bounds.
 */
function resolveReplayLimit(rawLimit: unknown): number {
  const firstValue = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
  const parsedLimit = Number.parseInt(
    typeof firstValue === 'number' || typeof firstValue === 'string' ? String(firstValue) : '',
    10
  );

  //audit Assumption: replay clients may send invalid limits; failure risk: unbounded transcript reads or inconsistent empty payloads; expected invariant: positive bounded integer limit; handling strategy: default invalid values and clamp oversized requests.
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    return DEFAULT_REPLAY_LIMIT;
  }

  return Math.min(parsedLimit, MAX_REPLAY_LIMIT);
}

/**
 * Validate and normalize the replay request envelope.
 * Inputs/outputs: Express request -> replay state or null when invalid.
 * Edge cases: missing sessionId is treated as a client error.
 */
function resolveReplayRequestState(req: Request): ReplayRequestState | null {
  const source = resolveReplaySource(req);
  const sessionId = resolveReplaySessionId(req.params.sessionId) ?? resolveReplaySessionId(source.sessionId);

  //audit Assumption: route-param replay targets are more authoritative than body/query payloads; failure risk: caller-provided body sessionId replays the wrong transcript for `/sessions/:id/replay`; expected invariant: path-bound replay routes resolve one deterministic session id; handling strategy: prefer `req.params.sessionId` and fall back to body/query only when the path param is absent.
  //audit Assumption: replay requests must explicitly target one session; failure risk: broad transcript leakage or ambiguous resume behavior; expected invariant: non-empty sessionId is always present; handling strategy: reject requests missing sessionId.
  if (!sessionId) {
    return null;
  }

  return {
    sessionId,
    limit: resolveReplayLimit(source.limit)
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function resolveReplayTraceId(res: Response): string | null {
  const localsRecord = asRecord(res.locals);
  const traceId = localsRecord?.auditTraceId;
  return typeof traceId === 'string' && traceId.trim().length > 0 ? traceId.trim() : null;
}

function recordReplayTraceEvent(
  name: string,
  req: Request,
  res: Response,
  details: Record<string, unknown>
): void {
  const traceId = resolveReplayTraceId(res);

  recordTraceEvent(name, {
    traceId,
    method: req.method,
    path: req.path,
    ...details
  });
}

function resolveReplayTimestamp(
  messageRecord: Record<string, unknown>,
  meta: Record<string, unknown>
): number | string | null {
  const candidates = [messageRecord.timestamp, meta.timestamp];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) {
      return candidate;
    }

    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

function resolveReplayContent(messageRecord: Record<string, unknown>): string | null {
  const contentCandidates = [messageRecord.content, messageRecord.value, messageRecord.text];
  for (const candidate of contentCandidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Normalize a stored session message into a replay-safe turn.
 * Inputs/outputs: raw stored conversation entry + original index -> normalized replay turn or null.
 * Edge cases: malformed or blank-content entries are discarded instead of poisoning the replay transcript.
 */
function toReplayTurn(message: unknown, index: number): ReplayTurn | null {
  const messageRecord = asRecord(message);
  if (!messageRecord) {
    return null;
  }

  const content = resolveReplayContent(messageRecord);
  //audit Assumption: replay transcripts require explicit text content per turn; failure risk: stateless resume payloads contain blank or invalid entries; expected invariant: each returned turn has non-empty content; handling strategy: drop malformed turns.
  if (!content) {
    return null;
  }

  const meta = asRecord(messageRecord.meta) ?? {};
  const role =
    typeof messageRecord.role === 'string' && messageRecord.role.trim().length > 0
      ? messageRecord.role.trim()
      : 'user';

  return {
    index,
    role,
    content,
    timestamp: resolveReplayTimestamp(messageRecord, meta),
    meta
  };
}

/**
 * Serve normalized session replay payloads for resume/replay clients.
 * Inputs: Express request carrying `sessionId` and optional `limit`.
 * Output: JSON transcript payload with both detailed turns and minimal role/content replay items.
 * Edge cases: empty sessions return 404; malformed stored rows are dropped but reported.
 */
export async function handleReplayRequest(req: Request, res: Response): Promise<void> {
  const replayRequestState = resolveReplayRequestState(req);
  if (!replayRequestState) {
    recordReplayTraceEvent('sessions.replay.rejected', req, res, {
      reason: 'missing-session-id'
    });
    sendBadRequest(res, 'REPLAY_SESSION_ID_REQUIRED', ['sessionId is required']);
    return;
  }

  recordReplayTraceEvent('sessions.replay.requested', req, res, {
    sessionId: replayRequestState.sessionId,
    limit: replayRequestState.limit
  });

  try {
    const [fullConversation, restoreState] = await Promise.all([
      getConversation(replayRequestState.sessionId),
      buildSessionReplayRestoreState(replayRequestState.sessionId)
    ]);
    const startIndex = Math.max(fullConversation.length - replayRequestState.limit, 0);
    const replayTurns: ReplayTurn[] = [];
    let droppedCount = 0;

    for (let currentIndex = startIndex; currentIndex < fullConversation.length; currentIndex += 1) {
      const replayTurn = toReplayTurn(fullConversation[currentIndex], currentIndex);
      if (!replayTurn) {
        droppedCount += 1;
        continue;
      }

      replayTurns.push(replayTurn);
    }

    //audit Assumption: replay endpoints should distinguish missing transcripts from successful non-empty fetches; failure risk: clients resume against empty history silently; expected invariant: at least one normalized replay turn exists on success; handling strategy: return 404 with counts when nothing replayable is available.
    if (replayTurns.length === 0) {
      recordReplayTraceEvent('sessions.replay.not_found', req, res, {
        sessionId: replayRequestState.sessionId,
        totalCount: fullConversation.length,
        droppedCount,
        limit: replayRequestState.limit
      });

      res.status(404).json({
        status: 'error',
        message: 'Replay transcript not found',
        traceId: resolveReplayTraceId(res),
        data: {
          sessionId: replayRequestState.sessionId,
          totalCount: fullConversation.length,
          returnedCount: 0,
          droppedCount,
          truncated: false,
          limit: replayRequestState.limit
        },
        timestamp: new Date().toISOString()
      });
      return;
    }

    recordReplayTraceEvent('sessions.replay.succeeded', req, res, {
      sessionId: replayRequestState.sessionId,
      totalCount: fullConversation.length,
      returnedCount: replayTurns.length,
      droppedCount,
      truncated: startIndex > 0,
      limit: replayRequestState.limit,
      restoreStateAvailable: Boolean(restoreState),
      restoreStateSource: restoreState?.source ?? null
    });

    res.json({
      status: 'success',
      message: 'Replay transcript retrieved',
      traceId: resolveReplayTraceId(res),
      data: {
        sessionId: replayRequestState.sessionId,
        totalCount: fullConversation.length,
        returnedCount: replayTurns.length,
        droppedCount,
        truncated: startIndex > 0,
        limit: replayRequestState.limit,
        replay: replayTurns,
        transcript: replayTurns.map(turn => ({
          role: turn.role,
          content: turn.content
        })),
        restore: restoreState
      }
    });
  } catch (error: unknown) {
    //audit Assumption: replay retrieval failures must surface operational detail to callers and logs; failure risk: hidden resume outages; expected invariant: deterministic 500 payload on backend failure; handling strategy: structured error log plus normalized internal error response.
    replayLogger.error('Failed to retrieve replay transcript', {
      operation: 'handleReplayRequest',
      sessionId: replayRequestState.sessionId,
      error: resolveErrorMessage(error)
    });

    recordReplayTraceEvent('sessions.replay.failed', req, res, {
      sessionId: replayRequestState.sessionId,
      error: resolveErrorMessage(error)
    });

    sendInternalErrorPayload(res, {
      status: 'error',
      message: 'Replay transcript retrieval failed',
      traceId: resolveReplayTraceId(res),
      error: resolveErrorMessage(error),
      timestamp: new Date().toISOString()
    });
  }
}
