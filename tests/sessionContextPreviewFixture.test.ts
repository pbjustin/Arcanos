import { afterEach, describe, expect, it, jest } from '@jest/globals';
import * as productionCore from '../src/shared/memory/sessionContextCore.js';
import * as productionPolicy from '../src/shared/memory/sessionContextPolicy.js';
import * as productionScope from '../src/platform/runtime/sessionContext.js';

const render = jest.fn(productionCore.buildSessionContextFromStoredTurns);
const eligible = jest.fn(productionPolicy.isSessionContextQueryAction);
const explicitScope = jest.fn(productionPolicy.resolveExplicitSessionContextId);
const runScope = jest.fn(productionScope.runWithSessionContext);
const readScope = jest.fn(productionScope.readSessionContext);
const buildMessages = jest.fn(productionScope.buildSessionContextMessages);
jest.unstable_mockModule('../src/shared/memory/sessionContextCore.js', () => ({
  ...productionCore, buildSessionContextFromStoredTurns: render,
}));
jest.unstable_mockModule('../src/shared/memory/sessionContextPolicy.js', () => ({
  isSessionContextQueryAction: eligible, resolveExplicitSessionContextId: explicitScope,
}));
jest.unstable_mockModule('../src/platform/runtime/sessionContext.js', () => ({
  runWithSessionContext: runScope, readSessionContext: readScope, buildSessionContextMessages: buildMessages,
}));
const { assertSessionContextPreviewFixture, SESSION_CONTEXT_PREVIEW_VERSION } =
  await import('../src/shared/memory/sessionContextPreviewFixture.js');
const FAILURE = 'SESSION_CONTEXT_PREVIEW_FIXTURE_FAILED';

afterEach(() => {
  render.mockImplementation(productionCore.buildSessionContextFromStoredTurns);
  eligible.mockImplementation(productionPolicy.isSessionContextQueryAction);
  explicitScope.mockImplementation(productionPolicy.resolveExplicitSessionContextId);
  runScope.mockImplementation(productionScope.runWithSessionContext);
  readScope.mockImplementation(productionScope.readSessionContext);
  buildMessages.mockImplementation(productionScope.buildSessionContextMessages);
});

describe('sealed session context component fixture', () => {
  it('executes production policy, rendering, and isolation without transport', async () => {
    const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Fixture must not invoke transport.'));
    try {
      await expect(assertSessionContextPreviewFixture()).resolves.toBeUndefined();
      expect(SESSION_CONTEXT_PREVIEW_VERSION).toBe('session-context/v1');
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it('keeps overlapping fixtures isolated and restores an enclosing request scope', async () => {
    await productionScope.runWithSessionContext('synthetic-enclosing-request', async () => {
      await expect(Promise.all([
        assertSessionContextPreviewFixture(), assertSessionContextPreviewFixture(),
      ])).resolves.toEqual([undefined, undefined]);
      expect(productionScope.readSessionContext()).toBe('synthetic-enclosing-request');
    });
    expect(productionScope.readSessionContext()).toBeUndefined();
  });

  it('fails if the stored history is replaced by an empty result', async () => {
    render.mockImplementation(sessionId => productionCore.createEmptySessionContextResult(sessionId, 'no_session_context'));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if stored delimiters can escape the data block', async () => {
    render.mockImplementation((...args) => {
      const result = productionCore.buildSessionContextFromStoredTurns(...args);
      return { ...result, renderedContext: result.renderedContext.replaceAll('\\u003c', '<').replaceAll('\\u003e', '>') };
    });
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it.each(['maxTurns', 'maxChars'] as const)('fails if the %s bound is ignored', async bound => {
    render.mockImplementation((sessionId, loaded, limits) => productionCore.buildSessionContextFromStoredTurns(
      sessionId, loaded, { ...limits, [bound]: 100_000 }
    ));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if tool history becomes a visible conversation turn', async () => {
    render.mockImplementation((sessionId, loaded, limits) => productionCore.buildSessionContextFromStoredTurns(
      sessionId,
      Array.isArray(loaded) ? loaded.map(turn => turn && typeof turn === 'object' && turn.role === 'tool'
        ? { ...turn, role: 'user' } : turn) : loaded,
      limits
    ));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if missing history is reported as hydrated', async () => {
    render.mockImplementation((...args) => {
      const result = productionCore.buildSessionContextFromStoredTurns(...args);
      return result.hydrated ? result : { ...result, hydrated: true };
    });
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if action eligibility admits status reads', async () => {
    eligible.mockImplementation((moduleName, action) => action === 'status'
      || productionPolicy.isSessionContextQueryAction(moduleName, action));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if an absent explicit scope is invented', async () => {
    explicitScope.mockImplementation((...args) => productionPolicy.resolveExplicitSessionContextId(...args) ?? 'invented');
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if historical roles are promoted to system instructions', async () => {
    buildMessages.mockImplementation(() => productionScope.buildSessionContextMessages()
      .map(message => ({ ...message, role: 'system' as 'user' })));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if empty nested scopes inherit authorized history', async () => {
    runScope.mockImplementation((rendered, operation) => rendered === undefined
      ? operation() : productionScope.runWithSessionContext(rendered, operation));
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if a nested scope swallows its original failure', async () => {
    runScope.mockImplementation((rendered, operation) => {
      const result = productionScope.runWithSessionContext(rendered, operation);
      return rendered === 'synthetic-throw' && result instanceof Promise ? result.catch(() => undefined) : result;
    });
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });

  it('fails if request-local scope is replaced with one shared value', async () => {
    let shared: string | undefined;
    runScope.mockImplementation((rendered, operation) => {
      const previous = shared;
      shared = rendered;
      const result = operation();
      return result instanceof Promise ? result.finally(() => { shared = previous; }) : result;
    });
    readScope.mockImplementation(() => shared);
    buildMessages.mockImplementation(() => shared ? [{ role: 'user', content: shared }] : []);
    await expect(assertSessionContextPreviewFixture()).rejects.toThrow(FAILURE);
  });
});
