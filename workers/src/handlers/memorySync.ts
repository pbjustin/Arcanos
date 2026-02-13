import { getWorkerOpenAIAdapter } from '../infrastructure/sdk/openai.js';
import { MemoryStore } from '../infrastructure/memory/index.js';
import type { JobHandler } from '../jobs/index.js';

/**
 * Synchronize in-memory state to persistent store.
 * Handler for MEMORY_SYNC job type.
 */
export const memorySyncHandler: JobHandler<'MEMORY_SYNC'> = async ({ payload }) => {
  const { key, value, embed = false } = payload;

  try {
    // 1. Persist to database or file-backed memory store
    await MemoryStore.set(key, value);

    // 2. Optional embedding via OpenAI SDK
    if (embed) {
      //audit Assumption: embedding work is opt-in to avoid unnecessary API cost; risk: accidental token usage; invariant: only embed when requested; handling: guard by payload flag.
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const adapter = getWorkerOpenAIAdapter();
      const { embeddingModel } = adapter.getDefaults();

      const embedding = await adapter.embeddings.create({
        model: embeddingModel,
        input: text,
      });

      await MemoryStore.set(`${key}:embedding`, embedding.data[0].embedding);
    }

    return { status: 'success', key };
  } catch (err) {
    //audit Assumption: sync failures should bubble to queue retry policy; risk: silent data divergence; invariant: failure reaches supervisor; handling: rethrow original error.
    // Let ARCANOS queue supervisor handle retries
    throw err;
  }
};

/**
 * Rollback handler for MEMORY_SYNC operations
 * @param payload - The payload containing the key to rollback
 */
export async function rollback(payload: { key: string }): Promise<{ status: string; key: string }> {
  const { key } = payload;
  await MemoryStore.delete(key);
  await MemoryStore.delete(`${key}:embedding`);
  return { status: 'rolled_back', key };
}
