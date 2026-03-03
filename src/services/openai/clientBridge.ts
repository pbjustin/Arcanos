import type OpenAI from 'openai';
import type { OpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { getOpenAIAdapter } from "@core/adapters/openai.adapter.js";
import { getOrCreateClient } from '@arcanos/openai/unifiedClient';

/**
 * Helper to get OpenAI client (adapter preferred, legacy fallback)
 * This allows gradual migration to adapter pattern
 */
export function getOpenAIClientOrAdapter(): { adapter: OpenAIAdapter | null; client: OpenAI | null } {
  //audit Assumption: adapter is the canonical runtime entrypoint; risk: bypassing shared configuration; invariant: adapter checked first; handling: return adapter/client pair when initialized.
  try {
    const adapter = getOpenAIAdapter();
    return { adapter, client: adapter.getClient() };
  } catch {
    //audit Assumption: adapter may not be initialized yet during startup races; risk: transient null client; invariant: one initialization attempt via unified client; handling: try unified init path.
    const client = getOrCreateClient();
    if (!client) {
      return { adapter: null, client: null };
    }

    //audit Assumption: unified client init should also initialize adapter singleton; risk: divergent singleton state; invariant: adapter should resolve after successful init; handling: second adapter lookup with safe fallback.
    try {
      const adapter = getOpenAIAdapter();
      return { adapter, client: adapter.getClient() };
    } catch {
      return { adapter: null, client };
    }
  }
}

/**
 * Strict helper for flows that require both adapter and client.
 * Throws when OpenAI is unavailable so callers can handle a single failure mode.
 */
export function requireOpenAIClientOrAdapter(errorMessage = 'OpenAI adapter not initialized'): {
  adapter: OpenAIAdapter;
  client: OpenAI;
} {
  const { adapter, client } = getOpenAIClientOrAdapter();
  if (!adapter || !client) {
    throw new Error(errorMessage);
  }
  return { adapter, client };
}
