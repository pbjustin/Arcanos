import { Request, Response } from 'express';
import { saveMessage, getChannel, getConversation, type SessionMessage } from "@services/sessionMemoryService.js";
import { requireField } from "@shared/validation.js";
import { logger } from "@platform/logging/structuredLogging.js";
import { resolveErrorMessage } from "@core/lib/errors/index.js";
import { sendBadRequest, sendInternalErrorCode } from '@shared/http/index.js';

/**
 * Normalize a session message into the persisted conversation shape.
 * Inputs/outputs: session message payload -> `{ role, content }` pair or null when content is blank.
 * Edge cases: bare strings default to the `user` role.
 */
function normalizeMessage(message: SessionMessage): { role: string; content: string } | null {
  const clean = typeof message === 'string'
    ? { role: 'user', content: message.trim() }
    : {
        role: typeof message.role === 'string' ? message.role : 'user',
        content: typeof message.content === 'string' ? message.content.trim() : '',
      };

  return clean.content ? clean : null;
}

/**
 * Extract the system-meta payload that accompanies a persisted session message.
 * Inputs/outputs: raw message payload + timestamp -> persisted metadata record.
 * Edge cases: missing token/tag fields degrade to deterministic defaults.
 */
function extractMessageMeta(message: SessionMessage, timestamp: number): Record<string, unknown> {
  return {
    tokens: typeof message === 'object' && message && typeof message.tokens === 'number' ? message.tokens : 0,
    audit_tag: typeof message === 'object' && message && typeof message.tag === 'string' ? message.tag : 'unspecified',
    timestamp,
  };
}

/**
 * Validate the required fields for a session-memory save request.
 * Inputs/outputs: Express request/response -> validated `{ sessionId, message }` or null after responding.
 * Edge cases: missing fields short-circuit through `requireField`.
 */
function validateSaveRequest(req: Request, res: Response): { sessionId: string; message: SessionMessage } | null {
  const { sessionId, message } = req.body as { sessionId?: string; message?: SessionMessage };
  
  if (!requireField(res, sessionId, 'sessionId') || !requireField(res, message, 'message')) {
    return null;
  }
  // requireField ensures truthy; TS doesn't narrow from it
  return { sessionId: sessionId!, message: message! };
}

interface SessionSaveState {
  sessionId: string;
  normalizedMessage: { role: string; content: string; timestamp: number };
  meta: Record<string, unknown>;
}

/**
 * Resolve all validated save-state dependencies for the dual-write session endpoint.
 * Inputs/outputs: Express request/response -> normalized save state or null after responding.
 * Edge cases: invalid message content returns a 400 before any persistence is attempted.
 */
function resolveSessionSaveState(req: Request, res: Response): SessionSaveState | null {
  const validation = validateSaveRequest(req, res);
  if (!validation) {
    return null;
  }

  const normalizedMessage = normalizeMessage(validation.message);
  //audit Assumption: empty message bodies should fail before persistence; failure risk: blank rows pollute both conversation and meta channels; expected invariant: saveDual writes only non-empty content; handling strategy: respond with 400 and short-circuit.
  if (!normalizedMessage) {
    sendBadRequest(res, 'message content is required');
    return null;
  }

  const timestamp = Date.now();
  return {
    sessionId: validation.sessionId,
    normalizedMessage: {
      ...normalizedMessage,
      timestamp,
    },
    meta: extractMessageMeta(validation.message, timestamp),
  };
}

interface SessionReadHandlerConfig {
  operation: 'getCore' | 'getMeta' | 'getFull';
  load: (sessionId: string) => Promise<unknown>;
  failureMessage: string;
}

/**
 * Build a consistent session-memory read handler with shared logging and error mapping.
 * Inputs/outputs: loader config -> Express handler for the requested session channel.
 * Edge cases: loader errors are logged once and mapped to the supplied internal-error message.
 */
function createSessionReadHandler(config: SessionReadHandlerConfig) {
  return async (req: Request, res: Response): Promise<void> => {
    const { sessionId } = req.params;

    try {
      const data = await config.load(sessionId);
      res.json(data);
    } catch (error: unknown) {
      //audit Assumption: read handlers should share one logging/error path so route maintenance stays consistent; failure risk: channel-specific handlers drift in status codes or log metadata; expected invariant: each read operation logs the same module + operation contract; handling strategy: centralize the catch block in the handler factory.
      logger.error(`Failed to ${config.operation} session data`, {
        module: 'sessionMemory',
        operation: config.operation,
        sessionId,
        error: resolveErrorMessage(error)
      });

      sendInternalErrorCode(res, config.failureMessage);
    }
  };
}

export const sessionMemoryController = {
  saveDual: async (req: Request, res: Response) => {
    const sessionSaveState = resolveSessionSaveState(req, res);
    if (!sessionSaveState) return;

    const { sessionId, normalizedMessage, meta } = sessionSaveState;

    try {
      await saveMessage(sessionId, 'conversations_core', normalizedMessage);
      await saveMessage(sessionId, 'system_meta', meta);

      logger.info('Session memory saved', {
        module: 'sessionMemory',
        operation: 'saveDual',
        sessionId,
        role: normalizedMessage.role,
        contentLength: normalizedMessage.content.length
      });

      res.status(200).json({ status: 'saved' });
    } catch (error: unknown) {
      logger.error('Failed to save session memory', {
        module: 'sessionMemory',
        operation: 'saveDual',
        sessionId,
        error: resolveErrorMessage(error)
      });

      sendInternalErrorCode(res, 'Failed to save message');
    }
  },

  getCore: createSessionReadHandler({
    operation: 'getCore',
    load: (sessionId: string) => getChannel(sessionId, 'conversations_core'),
    failureMessage: 'Failed to retrieve core data'
  }),

  getMeta: createSessionReadHandler({
    operation: 'getMeta',
    load: (sessionId: string) => getChannel(sessionId, 'system_meta'),
    failureMessage: 'Failed to retrieve meta data'
  }),

  getFull: createSessionReadHandler({
    operation: 'getFull',
    load: getConversation,
    failureMessage: 'Failed to retrieve conversation'
  })
};
