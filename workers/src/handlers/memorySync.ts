import openai from '../infrastructure/sdk/openai.js';
import { MemoryStore } from '../infrastructure/memory/index.js';
import type { JobHandler } from '../jobs/index.js';

console.log('[memorySync] Initialized handler module');

// Default embedding model, aligned with main OpenAI service
const DEFAULT_EMBEDDING_MODEL = 'text-embedding-3-large';

/**
 * Synchronize in-memory state to persistent store.
 * Handler for MEMORY_SYNC job type.
 */
export const memorySyncHandler: JobHandler<'MEMORY_SYNC'> = async ({ payload }) => {
  const { key, value, embed = false } = payload;
  console.log(`[memorySync] Run started for key: ${key}`);

  try {
    // 1. Persist to database or file-backed memory store
    await MemoryStore.set(key, value);
    console.log(`[memorySync] MemoryStore sync complete for ${key}`);

    // 2. Optional embedding via OpenAI SDK
    if (embed) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const model = process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL;

      const embedding = await openai.embeddings.create({
        model,
        input: text,
      });

      await MemoryStore.set(`${key}:embedding`, embedding.data[0].embedding);
      console.log(
        `[memorySync] Embedding stored for ${key} (model: ${model}, dim: ${embedding.data[0].embedding.length})`
      );
    }

    console.log(`[memorySync] Run complete for key: ${key}`);
    return { status: 'success', key };
  } catch (err) {
    console.error(`[memorySync] ERROR syncing key ${key}:`, err instanceof Error ? err.message : err);
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
  console.warn(`[memorySync] Rollback invoked for key: ${key}`);
  await MemoryStore.delete(key);
  await MemoryStore.delete(`${key}:embedding`);
  return { status: 'rolled_back', key };
}
