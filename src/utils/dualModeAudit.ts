import { getOpenAIClient } from '../services/openai.js';
import type OpenAI from 'openai';

export interface DualModeAuditOptions {
  /** run in simulation mode instead of hitting backend */
  simulate?: boolean;
  /** override backend registry base url */
  backendRegistry?: string;
  /** pre-configured OpenAI client for simulation mode */
  client?: OpenAI;
  /** custom fetch implementation for backend mode */
  fetcher?: typeof fetch;
}

export interface DualModeAuditBaseResult {
  timestamp: string;
  mode: 'backend' | 'simulation';
  module: string;
  exists: boolean;
  fallback_used: boolean;
  interference: boolean;
  error?: string;
  [key: string]: any;
}

/**
 * Performs a dual-mode audit against a backend registry or via simulated AI.
 *
 * Backend mode will call a real HTTP endpoint to verify the module, while
 * simulation mode leverages the OpenAI SDK to emulate the result. The function
 * is designed to be easily reusable and testable by allowing dependency
 * injection of the OpenAI client and fetch implementation.
 *
 * @param moduleName Name of the module to audit
 * @param options Optional configuration for the audit
 */
export async function dualModeAudit(
  moduleName: string,
  options: DualModeAuditOptions = {}
): Promise<DualModeAuditBaseResult> {
  const {
    simulate = false,
    backendRegistry = process.env.BACKEND_REGISTRY_URL ||
      'https://your-real-service.com/registry',
    client,
    fetcher = fetch
  } = options;

  const timestamp = new Date().toISOString();

  if (!simulate) {
    try {
      const res = await fetcher(`${backendRegistry}/${encodeURIComponent(moduleName)}`);
      if (!res.ok) {
        return {
          timestamp,
          mode: 'backend',
          module: moduleName,
          exists: false,
          fallback_used: false,
          interference: false,
          error: `HTTP ${res.status}`
        };
      }

      const data = await res.json().catch(() => ({}));
      return {
        timestamp,
        mode: 'backend',
        module: moduleName,
        exists: Boolean(data.exists),
        fallback_used: false,
        interference: false
      };
    } catch (err: any) {
      return {
        timestamp,
        mode: 'backend',
        module: moduleName,
        exists: false,
        fallback_used: false,
        interference: false,
        error: err?.message || String(err)
      };
    }
  }

  // Simulation mode
  try {
    const openai = client || getOpenAIClient();
    if (!openai) {
      return {
        timestamp,
        mode: 'simulation',
        module: moduleName,
        exists: false,
        fallback_used: true,
        interference: false,
        error: 'OpenAI client not available'
      };
    }

    const response = await openai.chat.completions.create({
      model: 'ft:gpt-3.5-turbo-0125:personal:arcanos-v2:BxRSDrhH',
      messages: [
        {
          role: 'system',
          content: 'You are ARCANOS in shadow audit mode. Simulate module presence.'
        },
        {
          role: 'user',
          content: `Simulate audit for module "${moduleName}". Respond with structured JSON.`
        }
      ],
      response_format: { type: 'json_object' }
    });

    let payload: Record<string, any> = {};
    try {
      const content = response.choices?.[0]?.message?.content || '{}';
      payload = JSON.parse(content);
    } catch (parseErr) {
      payload = { parseError: (parseErr as Error).message };
    }

    return {
      timestamp,
      mode: 'simulation',
      module: moduleName,
      ...payload
    } as DualModeAuditBaseResult;
  } catch (error: any) {
    return {
      timestamp,
      mode: 'simulation',
      module: moduleName,
      exists: false,
      fallback_used: false,
      interference: false,
      error: error?.message || String(error)
    };
  }
}

export default dualModeAudit;
