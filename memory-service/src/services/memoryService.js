import { v4 as uuidv4 } from "uuid";
import { z } from "zod";
import { config } from "../config/env.js";

const MemoryPayloadSchema = z
  .object({
    trace_id: z.string().uuid().optional(),
    content: z.any(),
    metadata: z.record(z.any()).optional(),
    tags: z.array(z.string()).optional()
  })
  .passthrough();

const memoryStore = new Map();

function persist(id, payload) {
  if (config.storageProvider !== "in-memory") {
    console.warn(
      `Storage provider "${config.storageProvider}" is not implemented. Falling back to in-memory storage.`
    );
  }
  memoryStore.set(id, payload);
}

export const memoryService = {
  async commit(rawPayload) {
    const payload = MemoryPayloadSchema.parse(rawPayload);
    const id = payload.trace_id || uuidv4();
    const record = {
      ...payload,
      id,
      saved_at: new Date().toISOString()
    };
    persist(id, record);
    return { status: "success", id };
  },

  async retrieve(id) {
    if (!id) {
      return { error: "Trace ID required" };
    }
    return memoryStore.get(id) || { error: "Not found" };
  }
};
