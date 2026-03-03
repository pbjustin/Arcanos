import OpenAI from "openai";

/**
 * Minimal, shared OpenAI client constructor used across backend, workers, and runtime.
 *
 * Keep this module dependency-free (no platform imports) so it can be consumed anywhere in the monorepo.
 */
export interface OpenAIClientConfig {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /**
   * Optional request timeout in milliseconds (OpenAI SDK will apply it per request).
   * Note: the OpenAI JS SDK uses `timeout` on the client in some versions; in others it is per-request.
   * We forward it as-is; callers may also pass AbortSignal per request.
   */
  timeoutMs?: number;
}

export function createOpenAIClient(config: OpenAIClientConfig): OpenAI {
  // The OpenAI constructor signature is stable: new OpenAI({ apiKey, baseURL, defaultHeaders, timeout })
  // `timeout` is accepted by many recent SDK versions; if a given version ignores it, AbortSignals still work.
  return new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders: config.defaultHeaders,
    timeout: config.timeoutMs
  });
}
