import { aiLogger } from '../utils/structuredLogging.js';
import type { ClearFeedbackPayload } from '../types/reinforcement.js';

interface ClearDeliveryResult {
  delivered: boolean;
  status?: number;
  message?: string;
  response?: unknown;
}

const CLEAR_ENDPOINT_ENV_KEYS = ['CLEAR_WEBHOOK_URL', 'CLEAR_ENDPOINT', 'CLEAR_FEEDBACK_URL'] as const;

function resolveEndpoint(): string | undefined {
  for (const key of CLEAR_ENDPOINT_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export async function sendClearFeedback(payload: ClearFeedbackPayload): Promise<ClearDeliveryResult> {
  const endpoint = resolveEndpoint();
  if (!endpoint) {
    aiLogger.debug('CLEAR endpoint not configured, skipping delivery', {
      operation: 'clearClient:deliver'
    });
    return { delivered: false, message: 'CLEAR endpoint not configured' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const text = await response.text();
    let parsed: unknown = undefined;

    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) {
      aiLogger.warn('CLEAR endpoint returned non-success status', {
        operation: 'clearClient:deliver',
        status: response.status,
        endpoint
      });

      return {
        delivered: false,
        status: response.status,
        message: text || response.statusText,
        response: parsed
      };
    }

    aiLogger.info('CLEAR feedback delivered', {
      operation: 'clearClient:deliver',
      status: response.status,
      endpoint
    });

    return {
      delivered: true,
      status: response.status,
      message: 'Delivered',
      response: parsed
    };
  } catch (error) {
    aiLogger.warn('Failed to deliver CLEAR feedback', {
      operation: 'clearClient:deliver',
      endpoint
    }, error instanceof Error ? error : undefined);

    return {
      delivered: false,
      message: error instanceof Error ? error.message : 'Unknown transport error'
    };
  }
}
