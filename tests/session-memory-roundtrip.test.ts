import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import memoryStore from '../src/memory/store.js';

const persistedChannels = new Map<string, unknown[]>();
const loadMemoryMock = jest.fn<(key: string) => Promise<unknown>>();
const saveMemoryMock = jest.fn<(key: string, value: unknown[]) => Promise<void>>();

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: loadMemoryMock,
  saveMemory: saveMemoryMock
}));

const { SessionMemoryRepository } = await import('../src/services/sessionMemoryRepository.js');

describe('session memory round trip', () => {
  beforeEach(() => {
    persistedChannels.clear();
    jest.clearAllMocks();

    //audit Assumption: the memory store singleton is shared across Jest tests; failure risk: prior sessions bleed into fallback assertions; expected invariant: each test starts with an empty synthetic cache; handling strategy: replace the backing map before seeding test data.
    (memoryStore as { sessions: Map<string, unknown> }).sessions = new Map();

    saveMemoryMock.mockImplementation(async (key, value) => {
      persistedChannels.set(key, value.map(entry => structuredClone(entry)));
    });

    loadMemoryMock.mockImplementation(async key => {
      const stored = persistedChannels.get(key);
      return stored ? stored.map(entry => structuredClone(entry)) : null;
    });
  });

  it('stores and retrieves raw messages with metadata', async () => {
    const sessionId = `test-session-${randomUUID()}`;
    const repository = new SessionMemoryRepository({ fallbackTtlMs: 1 });

    await repository.appendMessage(sessionId, 'conversations_core', {
      role: 'user',
      content: 'Hello',
      timestamp: 1
    });
    await repository.appendMessage(sessionId, 'system_meta', {
      tokens: 1,
      audit_tag: 'test',
      timestamp: 1
    });
    await repository.appendMessage(sessionId, 'conversations_core', {
      role: 'assistant',
      content: 'Hi there',
      timestamp: 2
    });
    await repository.appendMessage(sessionId, 'system_meta', {
      tokens: 2,
      audit_tag: 'test',
      timestamp: 2
    });

    const conversation = await repository.getConversation(sessionId);
    expect(conversation).toEqual([
      {
        role: 'user',
        content: 'Hello',
        timestamp: 1,
        meta: { tokens: 1, audit_tag: 'test', timestamp: 1 }
      },
      {
        role: 'assistant',
        content: 'Hi there',
        timestamp: 2,
        meta: { tokens: 2, audit_tag: 'test', timestamp: 2 }
      }
    ]);
  });

  it('falls back to process cache when persistent channels are unavailable', async () => {
    const sessionId = `process-cache-session-${randomUUID()}`;
    const repository = new SessionMemoryRepository({ fallbackTtlMs: 1 });

    loadMemoryMock.mockRejectedValue(new Error('session cache offline'));

    memoryStore.saveSession({
      sessionId,
      conversations_core: [
        {
          role: 'user',
          content: 'Here is my Arcanos Gaming guide',
          timestamp: 123
        }
      ],
      metadata: {
        tokens: 42,
        audit_tag: 'guide',
        timestamp: 123
      }
    });

    const conversation = await repository.getConversation(sessionId);
    expect(conversation).toEqual([
      {
        role: 'user',
        content: 'Here is my Arcanos Gaming guide',
        timestamp: 123,
        meta: {
          tokens: 42,
          audit_tag: 'guide',
          timestamp: 123
        }
      }
    ]);
  });
});
