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
      //audit assumption: the first configured endpoint should be used
      //audit failure risk: misconfigured endpoints may be ignored
      //audit expected invariant: returns first non-empty endpoint
      //audit handling strategy: trim and return the first match
      return value.trim();
    }
  }
  //audit assumption: no endpoint is configured
  //audit failure risk: delivery is skipped without operator awareness
  //audit expected invariant: undefined indicates no endpoint
  //audit handling strategy: return undefined and log caller decision
  return undefined;
}

/**
 * Send CLEAR audit feedback to the configured external endpoint.
 * Inputs: validated ClearFeedbackPayload.
 * Outputs: delivery metadata including status and response body.
 * Edge cases: missing endpoints or network failures return delivered=false.
 */
export async function sendClearFeedback(payload: ClearFeedbackPayload): Promise<ClearDeliveryResult> {
  const endpoint = resolveEndpoint();
  if (!endpoint) {
    //audit assumption: outbound delivery is optional and can be skipped
    //audit failure risk: missing endpoint might hide operational misconfiguration
    //audit expected invariant: no endpoint means no delivery attempt
    //audit handling strategy: log debug and return nondelivery result
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
        //audit assumption: non-JSON response is still valuable for diagnostics
        //audit failure risk: non-JSON payload could be misinterpreted
        //audit expected invariant: parsed contains either JSON or raw text
        //audit handling strategy: store raw text when JSON parsing fails
        parsed = text;
      }
    }

    if (!response.ok) {
      //audit assumption: non-2xx responses indicate delivery failure
      //audit failure risk: upstream endpoint rejects payload silently
      //audit expected invariant: response.ok reflects delivery success
      //audit handling strategy: log warning and return failure metadata
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
    //audit assumption: fetch can throw on network or runtime errors
    //audit failure risk: delivery exceptions could go unnoticed
    //audit expected invariant: errors are logged with endpoint context
    //audit handling strategy: log warning and return failure metadata
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
