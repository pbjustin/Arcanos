import {
  saveMessage,
  getConversation,
  getMessage,
} from '../src/services/sessionMemoryService';

describe('session memory round trip', () => {
  it('stores and retrieves raw messages with metadata', async () => {
    const sessionId = 'test-session';

    await saveMessage(sessionId, 'conversations_core', {
      id: '1',
      role: 'user',
      content: 'Hello',
      timestamp: 1,
    });
    await saveMessage(sessionId, 'system_meta', {
      id: '1',
      tokens: 1,
      audit_tag: 'test',
      timestamp: 1,
    });

    await saveMessage(sessionId, 'conversations_core', {
      id: '2',
      role: 'assistant',
      content: 'Hi there',
      timestamp: 2,
    });
    await saveMessage(sessionId, 'system_meta', {
      id: '2',
      tokens: 2,
      audit_tag: 'test',
      timestamp: 2,
    });

    const convo = await getConversation(sessionId);
    expect(convo).toEqual([
      {
        id: '1',
        role: 'user',
        content: 'Hello',
        timestamp: 1,
        meta: { id: '1', tokens: 1, audit_tag: 'test', timestamp: 1 },
      },
      {
        id: '2',
        role: 'assistant',
        content: 'Hi there',
        timestamp: 2,
        meta: { id: '2', tokens: 2, audit_tag: 'test', timestamp: 2 },
      }
    ]);

    const single = await getMessage(sessionId, '1');
    expect(single).toEqual({
      id: '1',
      role: 'user',
      content: 'Hello',
      timestamp: 1,
      meta: { id: '1', tokens: 1, audit_tag: 'test', timestamp: 1 },
    });
  });
});

