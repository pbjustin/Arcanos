import crypto from 'crypto';

/**
 * Minimal in-process runtime to keep conversation and metadata
 * in separate memory buckets. This mimics the behaviour of the
 * OpenAI Runtime while remaining lightweight and compatible with
 * Railway deployments.
 */
export interface RuntimeMemory {
  messages: unknown[];
  metadata: Record<string, unknown>;
}

class OpenAIRuntime {
  private store = new Map<string, RuntimeMemory>();

  /** Creates a new session and returns its id */
  createSession(): string {
    const id = crypto.randomUUID();
    this.store.set(id, { messages: [], metadata: {} });
    return id;
  }

  /** Adds chat messages to the conversation scope */
  addMessages(sessionId: string, messages: unknown[]): void {
    const entry = this.store.get(sessionId);
    if (entry) {
      entry.messages.push(...messages);
    }
  }

  /** Stores metadata separate from the conversation scope */
  setMetadata(sessionId: string, metadata: Record<string, unknown>): void {
    const entry = this.store.get(sessionId);
    if (entry) {
      Object.assign(entry.metadata, metadata);
    }
  }

  /** Retrieves messages for a session */
  getMessages(sessionId: string): unknown[] {
    return this.store.get(sessionId)?.messages ?? [];
  }

  /** Retrieves metadata for a session */
  getMetadata(sessionId: string): Record<string, unknown> {
    return this.store.get(sessionId)?.metadata ?? {};
  }

  /** Clears all stored data for a session */
  reset(sessionId: string): void {
    this.store.delete(sessionId);
  }
}

export const runtime = new OpenAIRuntime();
export default OpenAIRuntime;
