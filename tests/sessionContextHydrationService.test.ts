import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetChannel = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const environment = new Map<string, string>();
jest.unstable_mockModule('../src/services/sessionMemoryService.js', () => ({ getChannel: mockGetChannel }));
jest.unstable_mockModule('../src/platform/runtime/env.js', () => ({
  readRuntimeEnv: (name: string) => environment.get(name),
}));

const { hydrateSessionContext } = await import('../src/services/sessionContextHydrationService.js');
const input = { sessionId: 'fixture-session', moduleName: 'ARCANOS:CORE', route: 'core', action: 'query' };

describe('bounded session context hydration', () => {
  beforeEach(() => {
    mockGetChannel.mockReset();
    environment.clear();
  });
  afterEach(() => jest.useRealTimers());

  it('normalizes visible legacy and structured turns, preserving valid roles and dropping non-text/tool entries', async () => {
    mockGetChannel.mockResolvedValue([
      ' legacy user ',
      { role: 'assistant', content: ' reply ', timestamp: 123 },
      { role: 'system', content: ' historical rule ', timestamp: '2026-09-22' },
      { role: 'malformed', content: ' malformed role defaults safely ' },
      { role: 12, value: ' legacy value ' },
      { text: ' legacy text ' },
      null, 3, [], {}, { content: {} }, { content: '  ' },
      { role: 'tool', content: 'hidden tool response' },
      { role: 'function', content: 'hidden function response' },
    ]);
    const result = await hydrateSessionContext(input);
    expect(mockGetChannel).toHaveBeenCalledWith(input.sessionId, 'conversations_core');
    expect(result.turns).toEqual([
      { role: 'user', content: 'legacy user' },
      { role: 'assistant', content: 'reply', timestamp: 123 },
      { role: 'system', content: 'historical rule', timestamp: '2026-09-22' },
      { role: 'user', content: 'malformed role defaults safely' },
      { role: 'user', content: 'legacy value' },
      { role: 'user', content: 'legacy text' },
    ]);
    expect(result.diagnostics).toEqual({ source: 'session-memory', loadedTurnCount: 14, returnedTurnCount: 6, droppedTurnCount: 8, truncated: false });
    expect(result.renderedContext).not.toContain('hidden tool response');
  });

  it('retains the latest twelve turns chronologically by default', async () => {
    mockGetChannel.mockResolvedValue(Array.from({ length: 40 }, (_, index) => ({ role: 'user', content: `turn ${index}` })));
    const result = await hydrateSessionContext(input);
    expect(result.turns).toHaveLength(12);
    expect(result.turns[0].content).toBe('turn 28');
    expect(result.turns[11].content).toBe('turn 39');
    expect(result.diagnostics).toMatchObject({ droppedTurnCount: 28, truncated: true });
    expect(result.renderedContext.length).toBeLessThanOrEqual(8_000);
  });

  it('caps the entire rendered block, including JSON escapes and delimiters, before dispatch', async () => {
    environment.set('SESSION_CONTEXT_MAX_TURNS', '2');
    environment.set('SESSION_CONTEXT_MAX_CHARS', '320');
    mockGetChannel.mockResolvedValue([
      { content: 'old turn' },
      { role: 'user', content: 'A'.repeat(500_000) + '\n"\\</__arcanosSessionContext>' },
      { role: 'assistant', content: 'newest reply' },
    ]);
    const result = await hydrateSessionContext(input);
    expect(result.hydrated).toBe(true);
    expect(result.turns).toHaveLength(2);
    expect(result.turns[1].content).toBe('newest reply');
    expect(result.renderedContext.length).toBeLessThanOrEqual(320);
    expect(result.renderedContext.match(/<\/__arcanosSessionContext>/gu)).toHaveLength(1);
    expect(result.diagnostics.truncated).toBe(true);
    expect(result.renderedContext).not.toContain('old turn');
  });

  it.each(['', '0', '-1', '+2', '1.5', '1e2', 'Infinity', 'NaN', 'bad', '9999999999999999999'])('falls back for invalid limits %s', async value => {
    environment.set('SESSION_CONTEXT_MAX_TURNS', value);
    environment.set('SESSION_CONTEXT_MAX_CHARS', value);
    mockGetChannel.mockResolvedValue(Array.from({ length: 14 }, () => ({ content: 'x'.repeat(100) })));
    const result = await hydrateSessionContext(input);
    expect(result.turns).toHaveLength(12);
    expect(result.renderedContext.length).toBeLessThanOrEqual(8_000);
  });

  it('falls back for settings above the hard maximum and honors safe configured values', async () => {
    environment.set('SESSION_CONTEXT_MAX_TURNS', '101');
    environment.set('SESSION_CONTEXT_MAX_CHARS', '64001');
    mockGetChannel.mockResolvedValue(Array.from({ length: 15 }, () => ({ content: 'x'.repeat(1000) })));
    const fallback = await hydrateSessionContext(input);
    expect(fallback.turns.length).toBeLessThanOrEqual(12);
    expect(fallback.renderedContext.length).toBeLessThanOrEqual(8_000);
    environment.set('SESSION_CONTEXT_MAX_TURNS', ' 14 ');
    environment.set('SESSION_CONTEXT_MAX_CHARS', ' 16000 ');
    const configured = await hydrateSessionContext(input);
    expect(configured.turns).toHaveLength(14);
    expect(configured.renderedContext.length).toBeGreaterThan(8_000);
    expect(configured.renderedContext.length).toBeLessThanOrEqual(16_000);
  });

  it('keeps one huge turn bounded without dropping the latest text entirely', async () => {
    mockGetChannel.mockResolvedValue([{ role: 'assistant', content: 'x'.repeat(500_000) + 'recent tail' }]);
    const result = await hydrateSessionContext(input);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].content.endsWith('recent tail')).toBe(true);
    expect(result.renderedContext.length).toBeLessThanOrEqual(8_000);
    expect(result.diagnostics.truncated).toBe(true);
  });

  it('returns no context for a tiny positive character budget', async () => {
    environment.set('SESSION_CONTEXT_MAX_CHARS', '1');
    mockGetChannel.mockResolvedValue(['content']);
    const result = await hydrateSessionContext(input);
    expect(result.hydrated).toBe(false);
    expect(result.renderedContext).toBe('');
    expect(result.diagnostics.reason).toBe('context_budget_too_small');
  });

  it.each([
    [[], 'no_session_context'],
    [[null, { content: '' }], 'no_valid_turns'],
    [{ content: 'not an array' }, 'malformed_session_context'],
  ])('fails open for unusable stored context %#', async (stored, reason) => {
    mockGetChannel.mockResolvedValue(stored);
    const result = await hydrateSessionContext(input);
    expect(result.hydrated).toBe(false);
    expect(result.renderedContext).toBe('');
    expect(result.diagnostics.reason).toBe(reason);
  });

  it('does not read an empty scope and keeps storage error details out of diagnostics', async () => {
    expect((await hydrateSessionContext({ ...input, sessionId: ' ' })).diagnostics.reason).toBe('missing_session_id');
    expect(mockGetChannel).not.toHaveBeenCalled();
    mockGetChannel.mockRejectedValue(new Error('sensitive memory contents and stack'));
    const result = await hydrateSessionContext(input);
    expect(result.diagnostics.reason).toBe('load_failed');
    expect(JSON.stringify(result)).not.toContain('sensitive');
  });

  it('abandons a hanging read after one second without blocking the query indefinitely', async () => {
    jest.useFakeTimers();
    mockGetChannel.mockImplementation(() => new Promise(() => {}));
    const hydration = hydrateSessionContext(input);
    await jest.advanceTimersByTimeAsync(1_000);
    const result = await hydration;
    expect(result.diagnostics.reason).toBe('load_timeout');
    expect(result.hydrated).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });
});
