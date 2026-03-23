import { describe, expect, it } from '@jest/globals';
import { executeSystemStateRequest } from '../src/services/systemState.js';
import { recordChatIntent } from '../src/routes/ask/intent_store.js';

describe('canonical system_state action', () => {
  it('returns strict system_state payload', () => {
    const result = executeSystemStateRequest({ sessionId: 'jest-system-state-read' });

    expect(result.mode).toBe('system_state');
    expect(result.intent).toBeDefined();
    expect(result.routing).toBeDefined();
    expect(result.backend).toBeDefined();
    expect(result.stateFreshness).toBeDefined();
    expect(result.generatedAt).toBeDefined();
  });

  it('updates session-scoped intent state and exposes it through system_state', () => {
    const sessionId = 'system-state-update-session';
    const intent = recordChatIntent('Implement governed backend mode dispatch', sessionId);

    const result = executeSystemStateRequest({
      sessionId,
      expectedVersion: intent.version,
      patch: {
        confidence: 0.9,
        phase: 'execution',
        status: 'active',
        label: 'governed-test-label'
      }
    });

    expect(result.intent.label).toBe('governed-test-label');
    expect(result.intent.phase).toBe('execution');
    expect(result.intent.status).toBe('active');
    expect(result.intent.confidence).toBe(0.9);
    expect(result.intent.version).toBe(intent.version + 1);
  });

  it('keeps anonymous system_state requests stateless', () => {
    const result = executeSystemStateRequest({});

    expect(result.intent.intentId).toBeNull();
    expect(result.intent.label).toBeNull();
  });

  it('throws a conflict when the optimistic lock version is stale', () => {
    const sessionId = 'system-state-conflict-session';
    const intent = recordChatIntent('Seed conflict state', sessionId);

    expect(() =>
      executeSystemStateRequest({
        sessionId,
        expectedVersion: intent.version + 100,
        patch: { confidence: 0.9, phase: 'execution' }
      })
    ).toThrow('system_state update conflict');
  });

  it('hard-fails incomplete system_state update input', () => {
    expect(() =>
      executeSystemStateRequest({
        patch: { status: 'active' }
      })
    ).toThrow("system_state updates require both 'expectedVersion' and 'patch'");
  });
});
