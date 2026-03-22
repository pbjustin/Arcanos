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

const router = express.Router();

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
  try {
    const incomingGptId = req.params.gptId;
    const requestLogger = (req as any).logger;
    applyCanonicalGptRouteHeaders(res, incomingGptId);

    requestLogger?.info?.("gpt.request.auth_state", {
      endpoint: req.originalUrl,
      gptId: incomingGptId,
      ...buildGptRequestAuthState(req),
    });

    const envelope = await routeGptRequest({
      gptId: incomingGptId,
      body: req.body,
      requestId: (req as any).requestId,
      logger: requestLogger,
      request: req,
    });

    if (!envelope.ok) {
      const statusCode = envelope.error.code === "UNKNOWN_GPT" ? 404 : 400;
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
      const diagnosticPayload = prepareBoundedClientJsonPayload(
        shapeClientRouteResult(envelope.result) as Record<string, unknown>,
        {
          logger: req.logger,
          logEvent: 'gpt.response.diagnostic',
        }
      );
      res.setHeader('x-response-bytes', String(diagnosticPayload.responseBytes));
      if (diagnosticPayload.truncated) {
        res.setHeader('x-response-truncated', 'true');
      }
      return res.json(diagnosticPayload.payload);
    }

    const publicEnvelope = prepareBoundedClientJsonPayload({
      ...envelope,
      result: shapeClientRouteResult(envelope.result),
    }, {
      logger: req.logger,
      logEvent: 'gpt.response',
    });

    res.setHeader('x-response-bytes', String(publicEnvelope.responseBytes));
    if (publicEnvelope.truncated) {
      res.setHeader('x-response-truncated', 'true');
    }

    return res.json(publicEnvelope.payload);
  } catch (err) {
    req.logger?.error?.('gpt.request.unexpected_failure', {
      endpoint: req.originalUrl,
      gptId: req.params.gptId,
      error: resolveErrorMessage(err)
    });
    return next(err);
  }
});

export default router;
