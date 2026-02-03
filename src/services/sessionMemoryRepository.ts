import type { SessionEntry, SessionMetadata } from '../memory/store.js';
import memoryStore from '../memory/store.js';
import { loadMemory, saveMemory } from '../db/index.js';
import { logger } from '../utils/structuredLogging.js';
import { getEnvNumber } from '../config/env.js';
import { resolveErrorMessage } from '../lib/errors/index.js';

type ChannelName = string;
type SessionMessage = Record<string, unknown> | string;

interface FallbackEntry {
  messages: SessionMessage[];
  expiresAt: number;
}

interface SessionMemoryRepositoryOptions {
  fallbackTtlMs?: number;
}

// Use config layer for env access (adapter boundary pattern)
const DEFAULT_FALLBACK_TTL_MS = getEnvNumber('SESSION_CACHE_TTL_MS', 300000);

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

function deriveMetadataFromMessage(message: unknown): SessionMetadata | undefined {
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

  async appendMessage(sessionId: string, channel: ChannelName, message: SessionMessage): Promise<void> {
    const key = this.makeKey(sessionId, channel);
    const history = await this.getChannel(sessionId, channel);
    const nextHistory = [...history, cloneMessage(message)];

    try {
      await saveMemory(key, nextHistory);
      this.fallback.delete(key);
    } catch (error: unknown) {
      //audit Assumption: persistence failures should fall back to cache
      this.setFallback(key, nextHistory);
      logger.warn('Falling back to in-process cache for session channel', {
        module: 'sessionMemoryRepository',
        operation: 'appendMessage',
        sessionId,
        channel,
        error: resolveErrorMessage(error)
      });
    }

    this.updateProcessCache(sessionId, channel, nextHistory, message);
  }

  async getChannel(sessionId: string, channel: ChannelName): Promise<SessionMessage[]> {
    const key = this.makeKey(sessionId, channel);

    try {
      const stored = await loadMemory(key);
      //audit Assumption: stored value may be an array or array-like
      if (Array.isArray(stored)) {
        this.fallback.delete(key);
        return cloneMessages(stored);
      }
      if (stored == null) {
        this.fallback.delete(key);
        return [];
      }
      if (isArrayLike(stored)) {
        const arrayLike = Array.from(stored);
        this.fallback.delete(key);
        return cloneMessages(arrayLike);
      }
    } catch (error: unknown) {
      const cached = this.getFallback(key);
      if (cached) {
        logger.warn('Using fallback cache for session channel', {
          module: 'sessionMemoryRepository',
          operation: 'getChannel',
          sessionId,
          channel,
          error: resolveErrorMessage(error)
        });
        return cloneMessages(cached);
      }
    }

    const processCached = this.getProcessCache(sessionId, channel);
    if (processCached) {
      logger.warn('Using process cache for session channel', {
        module: 'sessionMemoryRepository',
        operation: 'getChannel',
        sessionId,
        channel,
        source: 'processCache'
      });
      return cloneMessages(processCached);
    }

    return [];
  }

  async getConversation(sessionId: string): Promise<Array<Record<string, unknown>>> {
    const [core, meta] = await Promise.all([
      this.getChannel(sessionId, 'conversations_core'),
      this.getChannel(sessionId, 'system_meta')
    ]);

    return core.map((message, index) => ({
      ...(typeof message === 'object' && message ? message : { value: message }),
      meta: meta[index] || {}
    }));
  }

  getCachedSessions(): SessionEntry[] {
    return memoryStore.getAllSessions();
  }

  private makeKey(sessionId: string, channel: ChannelName): string {
    return `session:${sessionId}:${channel}`;
  }

  private getFallback(key: string): SessionMessage[] | null {
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

  private setFallback(key: string, messages: SessionMessage[]): void {
    this.fallback.set(key, {
      messages: cloneMessages(messages),
      expiresAt: Date.now() + this.fallbackTtlMs
    });
  }

  private getProcessCache(sessionId: string, channel: ChannelName): SessionMessage[] | null {
    const session = memoryStore.getSession(sessionId);
    if (!session) {
      return null;
    }

    if (channel === 'conversations_core' && Array.isArray(session.conversations_core)) {
      return session.conversations_core as SessionMessage[];
    }

    if (channel === 'system_meta') {
      if (Array.isArray(session.metadata)) {
        return session.metadata as SessionMessage[];
      }

      if (session.metadata) {
        return [session.metadata];
      }
    }

    return null;
  }

  private updateProcessCache(sessionId: string, channel: ChannelName, history: SessionMessage[], message: SessionMessage): void {
    const metadata = channel === 'system_meta' ? deriveMetadataFromMessage(message) : undefined;

    memoryStore.saveSession({
      sessionId,
      conversations_core: channel === 'conversations_core' ? history : undefined,
      metadata
    });
  }
}

function isArrayLike(value: unknown): value is ArrayLike<SessionMessage> {
  return typeof value === 'object' && value !== null && 'length' in value && typeof (value as { length?: unknown }).length === 'number';
}

const sessionMemoryRepository = new SessionMemoryRepository();

export { SessionMemoryRepository };
export default sessionMemoryRepository;
