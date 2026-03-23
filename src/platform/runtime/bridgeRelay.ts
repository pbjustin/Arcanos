import type { Request } from 'express';
import { tagRequest } from "@transport/http/tagRequest.js";
import { broadcastBridgeEvent } from "@services/bridgeSocket.js";
import { isBridgeEnabled } from "@platform/runtime/bridgeEnv.js";
import { resolveHeader } from "@transport/http/requestHeaders.js";

type RequestWithBridgeContext = Request & {
  requestId?: string;
  confirmationContext?: { gptId?: string };
};

interface BridgeRouteContext {
  endpoint: string;
  payload?: Record<string, unknown>;
  gptId?: string;
}

type BridgeModule = {
  bridge?: {
    active?: boolean;
    routeRequest?: (payload: unknown) => void;
  };
};

function resolveRequestId(req: RequestWithBridgeContext): string | undefined {
  if (typeof req.requestId === 'string' && req.requestId.trim().length > 0) {
    return req.requestId;
  }
  return resolveHeader(req.headers, 'x-request-id');
}

function resolveGptId(req: RequestWithBridgeContext): string | undefined {
  const param = typeof req.params?.gptId === 'string' ? req.params.gptId : undefined;
  const confirmation = req.confirmationContext?.gptId;
  //audit Assumption: canonical GPT identity is path-bound; failure risk: stale body metadata diverges from the requested route; expected invariant: bridge events tag the path GPT id when present; handling strategy: prefer route params and fall back only to confirmation context.
  return param || confirmation;
}

export async function routeBridgeRequest(
  req: RequestWithBridgeContext,
  context: BridgeRouteContext
): Promise<void> {
  if (!isBridgeEnabled()) {
    return;
  }

  const requestId = resolveRequestId(req);
  const gptId = context.gptId || resolveGptId(req);
  const payload = tagRequest(
    {
      endpoint: context.endpoint,
      method: req.method,
      path: req.originalUrl || req.path,
      requestId,
      gptId,
      timestamp: new Date().toISOString(),
      payload: context.payload
    },
    gptId,
    requestId
  );

  try {
    broadcastBridgeEvent(payload);
    const bridgeUrl = new URL('../../daemon/bridge.js', import.meta.url);
    const bridgeModule = (await import(bridgeUrl.href)) as BridgeModule;
    const { bridge } = bridgeModule;
    if (bridge?.active && typeof bridge.routeRequest === 'function') {
      bridge.routeRequest(payload);
    }
  } catch {
    console.log('[Bridge] Fallback triggered - bridge unavailable.');
  }
}
