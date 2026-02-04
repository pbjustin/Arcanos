import type OpenAI from 'openai';
import type { TranscriptionCreateParamsNonStreaming } from 'openai/resources/audio/transcriptions.js';
import type { OpenAIAdapter } from '../../adapters/openai.adapter.js';
import { getOpenAIAdapter } from '../../adapters/openai.adapter.js';
import type { ChatCompletion } from './types.js';
import { getOrCreateClient } from './unifiedClient.js';

/**
 * Helper to get OpenAI client (adapter preferred, legacy fallback)
 * This allows gradual migration to adapter pattern
 */
export function getOpenAIClientOrAdapter(): { adapter: OpenAIAdapter | null; client: OpenAI | null } {
  // Try adapter first (preferred)
  try {
    const adapter = getOpenAIAdapter();
    return { adapter, client: adapter.getClient() };
  } catch {
    // Fallback to legacy client for backward compatibility
    const client = getOrCreateClient();
    if (!client) {
      return { adapter: null, client: null };
    }
    // Create adapter wrapper for legacy client (temporary bridge)
    const adapter: OpenAIAdapter = {
      chat: { 
        completions: { 
          create: async (params) => {
            const nonStreamingParams = { ...params, stream: false } as typeof params & { stream: false };
            const result = await client.chat.completions.create(nonStreamingParams);
            return result as ChatCompletion;
          }
        } 
      },
      embeddings: { 
        create: async (params) => {
          return client.embeddings.create(params);
        }
      },
      audio: { 
        transcriptions: { 
          create: async (params: TranscriptionCreateParamsNonStreaming) => {
            return client.audio.transcriptions.create(params);
          }
        } 
      },
      getClient: () => client
    };
    return { adapter, client };
  }
}
