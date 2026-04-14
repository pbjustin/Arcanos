import type { NextFunction, Request, Response } from 'express';
import type { TrinityResult } from '@core/logic/trinity.js';
import { buildTrinityUserVisibleResponse } from '@shared/ask/trinityResponseSerializer.js';
import { extractDiagnosticTextInput } from '@shared/http/diagnosticRequest.js';
import {
  shapeClientRouteResult
} from '@shared/http/clientResponseGuards.js';
import {
  applyLegacyRouteDeprecationHeaders,
  buildCanonicalGptRoute
} from '@shared/http/gptRouteHeaders.js';
import { generateMockResponse } from '@services/openai/mock.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function extractLegacyTextInput(body: unknown): string {
  return extractDiagnosticTextInput(isRecord(body) ? body : undefined) ?? '';
}

function isMockLikeResult(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && value.activeModel === 'MOCK';
}

function isTrinityResultLike(value: unknown): value is TrinityResult {
  return isRecord(value)
    && typeof value.result === 'string'
    && isRecord(value.meta)
    && (
      Object.prototype.hasOwnProperty.call(value, 'dryRun')
      || Object.prototype.hasOwnProperty.call(value, 'fallbackSummary')
      || Object.prototype.hasOwnProperty.call(value, 'outputControls')
      || Object.prototype.hasOwnProperty.call(value, 'capabilityFlags')
    );
}

function isLegacyAiResponseLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && typeof value.result === 'string'
    && isRecord(value.meta);
}

function isCompletedSimulationResult(value: unknown): value is {
  mode: 'complete';
  scenario: string;
  result: string;
  metadata?: {
    model?: string;
    timestamp?: string;
    simulationId?: string;
    tokensUsed?: number;
  };
} {
  return isRecord(value)
    && value.mode === 'complete'
    && typeof value.result === 'string';
}

function buildLegacySimulationResponse(result: {
  mode: 'complete';
  scenario: string;
  result: string;
  metadata?: {
    model?: string;
    timestamp?: string;
    simulationId?: string;
    tokensUsed?: number;
  };
}) {
  const createdAtMs = Date.parse(result.metadata?.timestamp ?? '');
  const normalizedCreatedAt = Number.isFinite(createdAtMs)
    ? Math.floor(createdAtMs / 1000)
    : Math.floor(Date.now() / 1000);
  const tokenCount = typeof result.metadata?.tokensUsed === 'number' && Number.isFinite(result.metadata.tokensUsed)
    ? Math.max(0, Math.trunc(result.metadata.tokensUsed))
    : null;

  return {
    result: result.result,
    module: 'ARCANOS:SIM',
    endpoint: 'sim',
    meta: {
      id: result.metadata?.simulationId ?? `sim-${normalizedCreatedAt}`,
      created: normalizedCreatedAt,
      ...(tokenCount !== null
        ? {
            tokens: {
              prompt_tokens: 0,
              completion_tokens: tokenCount,
              total_tokens: tokenCount
            }
          }
        : {})
    },
    ...(readString(result.metadata?.model) ? { activeModel: readString(result.metadata?.model) } : {}),
    fallbackFlag: false
  };
}

export function createLegacyRouteDeprecationMiddleware(gptId: string) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    applyLegacyRouteDeprecationHeaders(res, buildCanonicalGptRoute(gptId));
    next();
  };
}

export function buildLegacyDispatchBody(body: unknown, action: string): Record<string, unknown> {
  return {
    action,
    payload: body
  };
}

export function buildLegacyArcanosDispatchBody(body: unknown): Record<string, unknown> {
  const normalizedBody = isRecord(body) ? body : {};
  const prompt = readString(normalizedBody.userInput);
  const sessionId = readString(normalizedBody.sessionId);
  const overrideAuditSafe = readString(normalizedBody.overrideAuditSafe);

  return {
    action: 'query',
    payload: {
      ...(prompt ? { prompt } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(overrideAuditSafe ? { overrideAuditSafe } : {})
    }
  };
}

export function buildLegacyModuleDispatchBody(action: string, payload: unknown): Record<string, unknown> {
  return {
    action,
    payload
  };
}

export function adaptLegacyAiRouteResult(
  endpointName: 'write' | 'guide' | 'sim',
  body: unknown,
  result: unknown
): unknown {
  const input = extractLegacyTextInput(body);

  if (isMockLikeResult(result) && input) {
    return {
      ...generateMockResponse(input, endpointName),
      endpoint: endpointName
    };
  }

  if (isTrinityResultLike(result)) {
    const clientContext = isRecord(body) && isRecord(body.clientContext)
      ? body.clientContext
      : undefined;

    return {
      ...buildTrinityUserVisibleResponse({
        trinityResult: result,
        endpoint: endpointName,
        ...(clientContext ? { clientContext } : {})
      }),
      endpoint: endpointName
    };
  }

  if (endpointName === 'sim' && isCompletedSimulationResult(result)) {
    return buildLegacySimulationResponse(result);
  }

  if (isLegacyAiResponseLike(result)) {
    return {
      ...result,
      endpoint: readString(result.endpoint) ?? endpointName
    };
  }

  if (isRecord(result)) {
    return {
      ...result,
      endpoint: endpointName
    };
  }

  return result;
}

export function adaptLegacyArcanosRouteResult(
  body: unknown,
  result: unknown
): unknown {
  const input = extractLegacyTextInput(body);

  if (isMockLikeResult(result) && input) {
    return generateMockResponse(input, 'arcanos');
  }

  if (!isRecord(result)) {
    return result;
  }

  const shapedResult = shapeClientRouteResult(result);
  if (!isRecord(shapedResult)) {
    return shapedResult;
  }

  return shapedResult;
}

export function unwrapLegacyModuleRouteResult(result: unknown): unknown {
  return result;
}
