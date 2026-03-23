import express from "express";
import { routeGptRequest } from "./_core/gptDispatch.js";
import {
  logGptConnection,
  logGptConnectionFailed,
  logGptAckSent,
  type GptRoutingInfo,
} from "@platform/logging/gptLogger.js";
import {
  prepareBoundedClientJsonPayload,
  shapeClientRouteResult
} from '@shared/http/clientResponseGuards.js';
import { applyCanonicalGptRouteHeaders } from '@shared/http/gptRouteHeaders.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getDiagnosticsSnapshot } from '@core/diagnostics.js';
import {
  createAbortError,
  isAbortError,
  runWithRequestAbortTimeout
} from '@arcanos/runtime';
import { hasDagOrchestrationIntentCue } from '@services/naturalLanguageMemory.js';
import { recordDagTraceTimeout } from '@platform/observability/appMetrics.js';

const router = express.Router();
const DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS = 12_000;
const MIN_GPT_ROUTE_HARD_TIMEOUT_MS = 10_000;
const MAX_GPT_ROUTE_HARD_TIMEOUT_MS = 15_000;

function resolveGptRouteHardTimeoutMs(): number {
  const configuredTimeoutMs = Number.parseInt(process.env.GPT_ROUTE_HARD_TIMEOUT_MS ?? '', 10);
  if (!Number.isFinite(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
    return DEFAULT_GPT_ROUTE_HARD_TIMEOUT_MS;
  }

  return Math.max(
    MIN_GPT_ROUTE_HARD_TIMEOUT_MS,
    Math.min(MAX_GPT_ROUTE_HARD_TIMEOUT_MS, Math.trunc(configuredTimeoutMs))
  );
}

function tryParseBodyRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }

  return null;
}

function normalizeRequestBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const recordBody = body as Record<string, unknown>;
    const entries = Object.entries(recordBody);
    if (entries.length === 1) {
      const [candidateJson, candidateValue] = entries[0];
      if (candidateValue === '' || candidateValue === null) {
        const reparsedBody = tryParseBodyRecord(candidateJson);
        if (reparsedBody) {
          return reparsedBody;
        }
      }
    }
    return recordBody;
  }

  if (typeof body === 'string' && body.trim().length > 0) {
    return tryParseBodyRecord(body);
  }

  return null;
}

function resolveRequestedAction(body: unknown): string | null {
  const normalizedBody = normalizeRequestBody(body);
  const action = normalizedBody?.action;
  return typeof action === 'string' && action.trim().length > 0
    ? action.trim().toLowerCase()
    : null;
}

function extractPromptText(body: unknown): string | null {
  const normalizedBody = normalizeRequestBody(body);
  const candidate =
    normalizedBody?.message ??
    normalizedBody?.prompt ??
    normalizedBody?.userInput ??
    normalizedBody?.content ??
    normalizedBody?.text ??
    normalizedBody?.query;

  return typeof candidate === 'string' && candidate.trim().length > 0
    ? candidate.trim()
    : null;
}

function resolveBodyGptId(body: unknown): string | null {
  const normalizedBody = normalizeRequestBody(body);
  const gptId = normalizedBody?.gptId;
  return typeof gptId === 'string' && gptId.trim().length > 0
    ? gptId.trim()
    : null;
}

function buildGptRequestAuthState(req: express.Request): Record<string, unknown> {
  const authorizationHeader = req.header("authorization");
  const cookieHeader = req.header("cookie");
  const csrfHeader = req.header("x-csrf-token") ?? req.header("csrf-token");
  const confirmedHeader = req.header("x-confirmed");
  const xGptIdHeader = req.header("x-gpt-id");
  const authUser = req.authUser;

  let authSource = "anonymous";
  if (authUser?.source) {
    authSource = `auth-user:${authUser.source}`;
  } else if (authorizationHeader) {
    authSource = "authorization-header";
  } else if (req.daemonToken) {
    authSource = "daemon-token";
  } else if (cookieHeader) {
    authSource = "cookie";
  }

  return {
    authenticated:
      Boolean(authUser) ||
      Boolean(req.daemonToken) ||
      Boolean(authorizationHeader) ||
      Boolean(cookieHeader),
    authSource,
    authUserSource: authUser?.source ?? null,
    bearerPresent: Boolean(authorizationHeader),
    webStatePresent: Boolean(cookieHeader),
    csrfPresent: Boolean(csrfHeader),
    confirmedYes: confirmedHeader === "yes",
    gptPathHeaderPresent: Boolean(xGptIdHeader),
  };
}

router.post("/:gptId", async (req, res, next) => {
  const routeTimeoutMs = resolveGptRouteHardTimeoutMs();
  const requestId = (req as any).requestId;
  const timeoutMessage = `GPT route timeout after ${routeTimeoutMs}ms`;
  const clientAbortController = new AbortController();
  const abortForClosedClient = () => {
    if (!res.writableEnded) {
      clientAbortController.abort(createAbortError('GPT route client disconnected'));
    }
  };

  res.on('close', abortForClosedClient);

  try {
    return await runWithRequestAbortTimeout(
      {
        timeoutMs: routeTimeoutMs,
        requestId,
        parentSignal: clientAbortController.signal,
        abortMessage: timeoutMessage
      },
      async () => {
        const incomingGptId = req.params.gptId;
        const requestLogger = (req as any).logger;
        const normalizedBody = normalizeRequestBody(req.body);
        const bodyGptId = resolveBodyGptId(req.body);
        const requestedAction = resolveRequestedAction(req.body);
        applyCanonicalGptRouteHeaders(res, incomingGptId);

        requestLogger?.info?.('gpt.request.timeout_plan', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          timeoutMs: routeTimeoutMs
        });

        requestLogger?.info?.('gpt.request.body', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          bodyType: normalizedBody ? 'json-object' : typeof req.body,
          body: normalizedBody ?? req.body ?? null
        });
        requestLogger?.info?.('gpt.request.action', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: requestedAction
        });

        if (bodyGptId) {
          requestLogger?.warn?.('gpt.request.invalid_body_gpt_id', {
            endpoint: req.originalUrl,
            pathGptId: incomingGptId,
            bodyGptId
          });
          return res.status(400).json({
            ok: false,
            error: {
              code: 'BODY_GPT_ID_FORBIDDEN',
              message: 'gptId must be supplied by the /gpt/{gptId} path only.'
            },
            _route: {
              requestId,
              gptId: incomingGptId,
              timestamp: new Date().toISOString()
            }
          });
        }

        requestLogger?.info?.("gpt.request.auth_state", {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          ...buildGptRequestAuthState(req),
        });

        if (requestedAction === 'diagnostics') {
          const diagnostics = await getDiagnosticsSnapshot(req.app);
          requestLogger?.info?.('gpt.request.diagnostics', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            internal: true,
            registeredGpts: Array.isArray(diagnostics.registered_gpts)
              ? diagnostics.registered_gpts.length
              : diagnostics.registered_gpts,
            routeCount: Array.isArray(diagnostics.active_routes)
              ? diagnostics.active_routes.length
              : diagnostics.active_routes
          });

          const diagnosticsSerializationStartedAt = Date.now();
          const diagnosticsPayload = prepareBoundedClientJsonPayload(
            diagnostics as unknown as Record<string, unknown>,
            {
              logger: req.logger,
              logEvent: 'gpt.response.diagnostics'
            }
          );
          requestLogger?.info?.('gpt.response.serialization', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: 'diagnostics',
            serializationMs: Date.now() - diagnosticsSerializationStartedAt,
            responseBytes: diagnosticsPayload.responseBytes,
            truncated: diagnosticsPayload.truncated,
          });

          res.setHeader('x-response-bytes', String(diagnosticsPayload.responseBytes));
          if (diagnosticsPayload.truncated) {
            res.setHeader('x-response-truncated', 'true');
          }
          return res.json(diagnosticsPayload.payload);
        }

        const envelope = await routeGptRequest({
          gptId: incomingGptId,
          body: normalizedBody ?? req.body,
          requestId,
          logger: requestLogger,
          request: req,
        });

        if (!envelope.ok) {
          const statusCode =
            envelope.error.code === "UNKNOWN_GPT"
              ? 404
              : envelope.error.code === "SYSTEM_STATE_CONFLICT"
              ? 409
              : envelope.error.code === "MODULE_TIMEOUT"
              ? 504
              : 400;
          requestLogger?.warn?.("gpt.request.route_result", {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            statusCode,
            ok: false,
            errorCode: envelope.error.code,
          });
          if (envelope.error.code === "UNKNOWN_GPT") {
            logGptConnectionFailed(incomingGptId);
            return res.status(404).json(envelope);
          }
          if (envelope.error.code === "SYSTEM_STATE_CONFLICT") {
            return res.status(409).json(envelope);
          }
          if (envelope.error.code === "MODULE_TIMEOUT") {
            return res.status(504).json(envelope);
          }
          return res.status(400).json(envelope);
        }

        const routingInfo: GptRoutingInfo = {
          gptId: envelope._route.gptId,
          moduleName: envelope._route.module ?? "unknown",
          route: envelope._route.route ?? "unknown",
          matchMethod: (envelope._route.matchMethod as any) ?? "none",
        };

        logGptConnection(routingInfo);
        logGptAckSent(routingInfo, (envelope._route.availableActions ?? []).length);
        requestLogger?.info?.("gpt.request.route_result", {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          statusCode: 200,
          ok: true,
          module: envelope._route.module ?? "unknown",
          route: envelope._route.route ?? "unknown",
        });

        if (
          envelope._route.route === 'diagnostic' &&
          typeof envelope.result === 'object' &&
          envelope.result !== null &&
          (envelope.result as Record<string, unknown>).route === 'diagnostic'
        ) {
          const diagnosticSerializationStartedAt = Date.now();
          const diagnosticPayload = prepareBoundedClientJsonPayload(
            shapeClientRouteResult(envelope.result) as Record<string, unknown>,
            {
              logger: req.logger,
              logEvent: 'gpt.response.diagnostic',
            }
          );
          requestLogger?.info?.('gpt.response.serialization', {
            endpoint: req.originalUrl,
            gptId: incomingGptId,
            action: envelope._route.action ?? 'diagnostic',
            serializationMs: Date.now() - diagnosticSerializationStartedAt,
            responseBytes: diagnosticPayload.responseBytes,
            truncated: diagnosticPayload.truncated,
          });
          res.setHeader('x-response-bytes', String(diagnosticPayload.responseBytes));
          if (diagnosticPayload.truncated) {
            res.setHeader('x-response-truncated', 'true');
          }
          return res.json(diagnosticPayload.payload);
        }

        const responseSerializationStartedAt = Date.now();
        const publicEnvelope = prepareBoundedClientJsonPayload({
          ...envelope,
          result: shapeClientRouteResult(envelope.result),
        }, {
          logger: req.logger,
          logEvent: 'gpt.response',
        });
        requestLogger?.info?.('gpt.response.serialization', {
          endpoint: req.originalUrl,
          gptId: incomingGptId,
          action: envelope._route.action ?? 'query',
          serializationMs: Date.now() - responseSerializationStartedAt,
          responseBytes: publicEnvelope.responseBytes,
          truncated: publicEnvelope.truncated,
        });

        res.setHeader('x-response-bytes', String(publicEnvelope.responseBytes));
        if (publicEnvelope.truncated) {
          res.setHeader('x-response-truncated', 'true');
        }

        return res.json(publicEnvelope.payload);
      }
    );
  } catch (err) {
    if (isAbortError(err)) {
      const promptText = extractPromptText(req.body);
      if (promptText && hasDagOrchestrationIntentCue(promptText)) {
        recordDagTraceTimeout({
          handler: 'gpt-route',
          reason: 'request_timeout',
        });
      }
      req.logger?.warn?.('gpt.request.timeout', {
        endpoint: req.originalUrl,
        gptId: req.params.gptId,
        timeoutMs: routeTimeoutMs,
        error: resolveErrorMessage(err)
      });
      if (!res.headersSent) {
        return res.status(504).json({
          ok: false,
          error: {
            code: 'REQUEST_TIMEOUT',
            message: timeoutMessage
          },
          _route: {
            requestId,
            gptId: req.params.gptId,
            timestamp: new Date().toISOString()
          }
        });
      }
      return;
    }

    req.logger?.error?.('gpt.request.unexpected_failure', {
      endpoint: req.originalUrl,
      gptId: req.params.gptId,
      error: resolveErrorMessage(err)
    });
    return next(err);
  } finally {
    res.off('close', abortForClosedClient);
  }
});

export default router;
