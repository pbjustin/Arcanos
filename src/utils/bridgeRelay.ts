import type { Request } from 'express';
import { tagRequest } from './tagRequest.js';

type RequestWithBridgeContext = Request & {
  requestId?: string;
  confirmationContext?: { gptId?: string };
};

interface BridgeRouteContext {
  endpoint: string;
  payload?: Record<string, unknown>;
  gptId?: string;
}

function normalizeHeaderValue(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function resolveRequestId(req: RequestWithBridgeContext): string | undefined {
  if (typeof req.requestId === 'string' && req.requestId.trim().length > 0) {
    return req.requestId;
  }
  return normalizeHeaderValue(req.headers['x-request-id']);
}

function resolveGptId(req: RequestWithBridgeContext): string | undefined {
  const header = normalizeHeaderValue(req.headers['x-gpt-id']);
  const param = typeof req.params?.gptId === 'string' ? req.params.gptId : undefined;
  const body = typeof (req.body as Record<string, unknown> | undefined)?.gptId === 'string'
    ? ((req.body as Record<string, unknown>).gptId as string)
    : undefined;
  const confirmation = req.confirmationContext?.gptId;
  return header || param || body || confirmation;
}

export async function routeBridgeRequest(
  req: RequestWithBridgeContext,
  context: BridgeRouteContext
): Promise<void> {
  if (process.env.BRIDGE_ENABLED !== 'true') {
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
    const { bridge } = await import('../../daemon/bridge.js');
    if (bridge?.active) {
      bridge.routeRequest(payload);
    }
  } catch (err) {
    console.log('[Bridge] Fallback triggered - bridge unavailable.');
  }
}
