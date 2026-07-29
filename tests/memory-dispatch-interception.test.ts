import { describe, expect, it } from '@jest/globals';

import { classifyGptMemoryInterception } from '../src/services/memoryDispatchInterception.js';

const queryModule = {
  availableActions: ['query', 'system_state'],
  fallbackActionCandidate: 'query',
} as const;

describe('GPT memory interception classification', () => {
  it('intercepts an actionless, explicit memory command on a query module', () => {
    expect(classifyGptMemoryInterception({
      body: {
        prompt: 'Remember this release marker for session audit-42.',
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: true,
      parsedIntent: 'save',
      hasMemoryCue: true,
      requestedAction: undefined,
    }));
  });

  it('preserves legacy ask-to-query alias behavior in the interception predicate', () => {
    expect(classifyGptMemoryInterception({
      body: {
        action: 'ask',
        prompt: 'Recall release marker for audit-42.',
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: true,
      parsedIntent: 'lookup',
      requestedAction: 'query',
    }));
  });

  it('preserves legacy chat-to-query alias behavior in the interception predicate', () => {
    expect(classifyGptMemoryInterception({
      body: {
        action: 'chat',
        prompt: 'Recall release marker for audit-42.',
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: true,
      parsedIntent: 'lookup',
      requestedAction: 'query',
    }));
  });

  it.each(['', false, 0, null])(
    'preserves legacy truthy prompt-alias fallback after an earlier %p value',
    (message) => {
      expect(classifyGptMemoryInterception({
        body: {
          message,
          prompt: 'Remember the later prompt alias.',
        },
        ...queryModule,
        forceDirectModuleRouting: false,
      })).toEqual(expect.objectContaining({
        intercept: true,
        prompt: 'Remember the later prompt alias.',
        parsedIntent: 'save',
      }));
    }
  );

  it('intercepts a known command without a memory cue only when no action is routable', () => {
    const body = { prompt: 'Get weather' };

    expect(classifyGptMemoryInterception({
      body,
      availableActions: [],
      fallbackActionCandidate: null,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: true,
      parsedIntent: 'retrieve',
      hasMemoryCue: false,
      hasNoRoutableAction: true,
    }));
    expect(classifyGptMemoryInterception({
      body,
      ...queryModule,
      forceDirectModuleRouting: false,
    }).intercept).toBe(false);
  });

  it('honors explicit payload prompt precedence used by the dispatcher', () => {
    expect(classifyGptMemoryInterception({
      body: {
        prompt: 'Remember the top-level text.',
        payload: {
          prompt: 'Explain dependency inversion.',
        },
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: false,
      prompt: 'Explain dependency inversion.',
      parsedIntent: 'unknown',
    }));

    expect(classifyGptMemoryInterception({
      body: {
        prompt: 'Remember the forwarded top-level text.',
        payload: {
          maxWords: 40,
        },
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: true,
      prompt: 'Remember the forwarded top-level text.',
      parsedIntent: 'save',
    }));
  });

  it('drops inherited prompt aliases when sanitizing an explicit payload', () => {
    const inheritedPayload = Object.create({
      message: 'Remember the inherited text.',
    }) as Record<string, unknown>;
    inheritedPayload.prompt = 'Explain dependency inversion.';

    expect(classifyGptMemoryInterception({
      body: {
        prompt: 'Remember the top-level text.',
        payload: inheritedPayload,
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: false,
      prompt: 'Explain dependency inversion.',
      parsedIntent: 'unknown',
    }));
  });

  it.each([
    ['scalar', 'Remember the scalar payload.'],
    ['null', null],
    ['array', ['Remember the array payload.']],
  ])('does not reinterpret an explicit %s payload as a prompt', (_label, payload) => {
    expect(classifyGptMemoryInterception({
      body: {
        prompt: 'Remember the top-level text.',
        payload,
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: false,
      prompt: null,
      parsedIntent: 'unknown',
    }));
  });

  it.each([
    ['explicit query bypass', { action: 'query' }, true],
    ['query-and-wait bypass', {}, true],
    ['forced direct module', {}, true],
  ])('does not intercept a memory command under %s', (_label, bodyFields, forceDirectModuleRouting) => {
    expect(classifyGptMemoryInterception({
      body: {
        ...bodyFields,
        prompt: 'Remember this should stay on direct module routing.',
      },
      ...queryModule,
      forceDirectModuleRouting,
    }).intercept).toBe(false);
  });

  it('does not intercept an explicit non-query module action', () => {
    expect(classifyGptMemoryInterception({
      body: {
        action: 'system_state',
        prompt: 'Remember this request wording.',
      },
      ...queryModule,
      forceDirectModuleRouting: false,
    })).toEqual(expect.objectContaining({
      intercept: false,
      requestedAction: 'system_state',
    }));
  });
});
