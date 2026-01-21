import type { JobHandler } from '../jobs/index.js';

const memoryStore = new Map<string, string>();

export const memorySetHandler: JobHandler<'MEMORY_SET'> = async ({ payload }) => {
  memoryStore.set(payload.key, payload.value);
  return { ok: true };
};

export const memoryGetHandler: JobHandler<'MEMORY_GET'> = async ({ payload }) => {
  return { value: memoryStore.get(payload.key) ?? null };
};
