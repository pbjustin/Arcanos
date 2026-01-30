import { callOpenAI, getDefaultModel, getFallbackModel, generateMockResponse } from '../services/openai.js';
import { recordTraceEvent } from '../utils/telemetry.js';
import { DecideInput, RouteExecutionResult, RouteSelection } from './types.js';
import { getEnvNumber } from '../config/env.js';

// Use config layer for env access (adapter boundary pattern)
const PRIMARY_TOKEN_LIMIT = getEnvNumber('AFOL_PRIMARY_TOKEN_LIMIT', 1024);
const BACKUP_TOKEN_LIMIT = getEnvNumber('AFOL_BACKUP_TOKEN_LIMIT', 1024);

function extractPrompt(input: DecideInput): string {
  if (typeof input.prompt === 'string') return input.prompt;
  if (typeof input.query === 'string') return input.query;
  if (typeof input.intent === 'string') return input.intent;
  if (typeof input.input === 'string') return input.input;
  if (typeof input.message === 'string') return input.message;
  const messages = (input as Record<string, unknown>).messages as unknown;
  if (Array.isArray(messages)) {
    const last = messages[messages.length - 1];
    const lastContent = getMessageContent(last);
    if (lastContent) {
      return lastContent;
    }
  }

  try {
    return JSON.stringify(input);
  } catch {
    return '[unavailable prompt]';
  }
}

function getMessageContent(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }
  const record = message as Record<string, unknown>;
  return typeof record.content === 'string' ? record.content : undefined;
}

async function executeModelRoute(
  route: RouteSelection,
  intent: string | undefined,
  prompt: string,
  model: string,
  tokenLimit: number
): Promise<RouteExecutionResult> {
  recordTraceEvent('afol.route.execute', {
    route: route.name,
    reason: route.reason,
    model,
    intent
  });

  try {
    const result = await callOpenAI(model, prompt, tokenLimit, true, {
      metadata: {
        route: route.name,
        reason: route.reason,
        intent
      }
    });

    recordTraceEvent('afol.route.success', {
      route: route.name,
      model: result.model,
      cached: result.cached
    });

    return {
      route: route.name,
      input: prompt,
      output: result.output,
      model: result.model,
      cached: result.cached,
      metadata: {
        routeReason: route.reason,
        intent
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    recordTraceEvent('afol.route.error', {
      route: route.name,
      error: message
    });

    const mock = generateMockResponse(prompt, 'ask');
    return {
      route: route.name,
      input: prompt,
      output: mock.result,
      model: mock.activeModel || 'mock',
      cached: false,
      error: message,
      metadata: {
        routeReason: route.reason,
        intent,
        degraded: true
      }
    };
  }
}

export async function executeRoute(route: RouteSelection, input: DecideInput): Promise<RouteExecutionResult> {
  const prompt = extractPrompt(input);
  const intent = typeof input.intent === 'string' ? input.intent : undefined;

  switch (route.name) {
    case 'primary':
      return executeModelRoute(route, intent, prompt, getDefaultModel(), PRIMARY_TOKEN_LIMIT);
    case 'backup':
      return executeModelRoute(route, intent, prompt, getFallbackModel(), BACKUP_TOKEN_LIMIT);
    default:
      recordTraceEvent('afol.route.reject', {
        intent,
        reason: route.reason
      });
      return {
        route: 'reject',
        input: prompt,
        error: route.reason,
        metadata: {
          intent,
          routeReason: route.reason
        }
      };
  }
}

