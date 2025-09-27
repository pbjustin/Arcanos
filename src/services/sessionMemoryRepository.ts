import type { SessionEntry, SessionMetadata } from '../memory/store.js';
import memoryStore from '../memory/store.js';
import { loadMemory, saveMemory } from '../db.js';
import { logger } from '../utils/structuredLogging.js';

type ChannelName = string;

interface FallbackEntry {
  messages: any[];
  expiresAt: number;
}

interface SessionMemoryRepositoryOptions {
  fallbackTtlMs?: number;
}

const DEFAULT_FALLBACK_TTL_MS = parseInt(process.env.SESSION_CACHE_TTL_MS || '300000', 10);

function cloneMessage<T>(message: T): T {
  if (Array.isArray(message)) {
    return [...message] as T;
  }

  if (message && typeof message === 'object') {
    return { ...(message as Record<string, unknown>) } as T;
  }

  return message;
}

function cloneMessages<T>(messages: T[]): T[] {
  return messages.map(item => cloneMessage(item));
}

function deriveMetadataFromMessage(message: any): SessionMetadata | undefined {
  if (!message || typeof message !== 'object') {
    return undefined;
  }

  const { topic, tags, summary, metadata } = message as Record<string, unknown>;
  const derived: SessionMetadata = {};

  if (typeof topic === 'string' && topic.trim()) {
    derived.topic = topic.trim();
  }

  if (Array.isArray(tags)) {
    derived.tags = tags.filter(tag => typeof tag === 'string' && tag.trim()).map(tag => tag.trim());
  }

  if (typeof summary === 'string' && summary.trim()) {
    derived.summary = summary.trim();
  }

  if (metadata && typeof metadata === 'object') {
    return { ...derived, ...metadata as Record<string, unknown> };
  }

  return Object.keys(derived).length > 0 ? derived : undefined;
}

class SessionMemoryRepository {
  private readonly fallback = new Map<string, FallbackEntry>();
  private readonly fallbackTtlMs: number;

  constructor(options: SessionMemoryRepositoryOptions = {}) {
    const ttl = options.fallbackTtlMs ?? DEFAULT_FALLBACK_TTL_MS;
    this.fallbackTtlMs = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_FALLBACK_TTL_MS;
  }

  async appendMessage(sessionId: string, channel: ChannelName, message: any): Promise<void> {
    const key = this.makeKey(sessionId, channel);
    const history = await this.getChannel(sessionId, channel);
    const nextHistory = [...history, cloneMessage(message)];

    try {
      await saveMemory(key, nextHistory);
      this.fallback.delete(key);
    } catch (error) {
      this.setFallback(key, nextHistory);
      logger.warn('Falling back to in-process cache for session channel', {
        module: 'sessionMemoryRepository',
        operation: 'appendMessage',
        sessionId,
        channel,
        error: (error as Error).message
      });
    }

    this.updateProcessCache(sessionId, channel, nextHistory, message);
  }

  async getChannel(sessionId: string, channel: ChannelName): Promise<any[]> {
    const key = this.makeKey(sessionId, channel);

    try {
      const stored = await loadMemory(key);
      if (Array.isArray(stored)) {
        this.fallback.delete(key);
        return cloneMessages(stored);
      }
      if (stored == null) {
        this.fallback.delete(key);
        return [];
      }
      if (typeof stored === 'object' && 'length' in (stored as any)) {
        const arrayLike = Array.from(stored as any);
        this.fallback.delete(key);
        return cloneMessages(arrayLike);
      }
    } catch (error) {
      const cached = this.getFallback(key);
      if (cached) {
        logger.warn('Using fallback cache for session channel', {
          module: 'sessionMemoryRepository',
          operation: 'getChannel',
          sessionId,
          channel,
          error: (error as Error).message
        });
        return cloneMessages(cached);
      }
    }

    return [];
  }

  async getConversation(sessionId: string): Promise<any[]> {
    const [core, meta] = await Promise.all([
      this.getChannel(sessionId, 'conversations_core'),
      this.getChannel(sessionId, 'system_meta')
    ]);

    return core.map((message, index) => ({
      ...message,
      meta: meta[index] || {}
    }));
  }

  getCachedSessions(): SessionEntry[] {
    return memoryStore.getAllSessions();
  }

  private makeKey(sessionId: string, channel: ChannelName): string {
    return `session:${sessionId}:${channel}`;
  }

  private getFallback(key: string): any[] | null {
    const cached = this.fallback.get(key);
    if (!cached) {
      return null;
    }

    if (cached.expiresAt <= Date.now()) {
      this.fallback.delete(key);
      return null;
    }

    return cloneMessages(cached.messages);
  }

  private setFallback(key: string, messages: any[]): void {
    this.fallback.set(key, {
      messages: cloneMessages(messages),
      expiresAt: Date.now() + this.fallbackTtlMs
    });
  }

  private updateProcessCache(sessionId: string, channel: ChannelName, history: any[], message: any): void {
    const metadata = channel === 'system_meta' ? deriveMetadataFromMessage(message) : undefined;

    memoryStore.saveSession({
      sessionId,
      conversations_core: channel === 'conversations_core' ? history : undefined,
      metadata
    });
  }
}

const sessionMemoryRepository = new SessionMemoryRepository();

export { SessionMemoryRepository };
export default sessionMemoryRepository;
