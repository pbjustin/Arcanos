import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { isRecord } from '../src/shared/typeGuards.js';

const payloadCore = await import('../src/shared/gpt/gptRequestAction.js');
const scopePolicy = await import('../src/shared/memory/sessionContextPolicy.js');
const renderingCore = await import('../src/shared/memory/sessionContextCore.js');
const contextRuntime = await import('../src/platform/runtime/sessionContext.js');
const buildPayload = jest.fn(payloadCore.buildGptDispatchPayload);
const resolveScope = jest.fn(scopePolicy.resolveExplicitSessionContextId);
const renderHistory = jest.fn(renderingCore.buildSessionContextFromStoredTurns);
const runWithContext = jest.fn(contextRuntime.runWithSessionContext);
const contextMessages = jest.fn(contextRuntime.buildSessionContextMessages);

jest.unstable_mockModule('@shared/gpt/gptRequestAction.js', () => ({
  ...payloadCore, buildGptDispatchPayload: buildPayload,
}));
jest.unstable_mockModule('../src/shared/memory/sessionContextPolicy.js', () => ({
  ...scopePolicy, resolveExplicitSessionContextId: resolveScope,
}));
jest.unstable_mockModule('../src/shared/memory/sessionContextCore.js', () => ({
  ...renderingCore, buildSessionContextFromStoredTurns: renderHistory,
}));
jest.unstable_mockModule('@platform/runtime/sessionContext.js', () => ({
  ...contextRuntime, runWithSessionContext: runWithContext, buildSessionContextMessages: contextMessages,
}));

const { SESSION_CONTEXT_PREVIEW_VERSION, runSessionContextPreviewContract } =
  await import('../src/shared/memory/sessionContextPreviewFixture.js');
const FAILURE = 'SESSION_CONTEXT_PREVIEW_FIXTURE_FAILED';

describe('sealed session scope fixture over production pure seams', () => {
  beforeEach(() => {
    buildPayload.mockReset().mockImplementation(payloadCore.buildGptDispatchPayload);
    resolveScope.mockReset().mockImplementation(scopePolicy.resolveExplicitSessionContextId);
    renderHistory.mockReset().mockImplementation(renderingCore.buildSessionContextFromStoredTurns);
    runWithContext.mockReset().mockImplementation(contextRuntime.runWithSessionContext);
    contextMessages.mockReset().mockImplementation(contextRuntime.buildSessionContextMessages);
  });

  afterEach(() => {
    expect(contextRuntime.readSessionContext()).toBeUndefined();
  });

  it('returns component evidence after actual payload, scope, rendering and isolation assertions', async () => {
    expect(SESSION_CONTEXT_PREVIEW_VERSION).toBe('session-context/v1');
    expect(await runSessionContextPreviewContract()).toEqual({
      ok: true,
      scope: 'sealed-component',
      proofVersion: 'session-scope-contract/v1',
      payloadForwarding: true,
      scopePrecedence: true,
      scopeNonInference: true,
      escapedUserHistory: true,
      currentPromptPreserved: true,
      originalPayloadUnchanged: true,
      requestContextIsolated: true,
      runtimeBoundaries: {
        authentication: false, persistence: false, gatewayProducer: false,
        workerExecution: false, provider: false,
      },
    });
    expect(buildPayload).toHaveBeenCalled();
    expect(renderHistory).toHaveBeenCalled();
    expect(contextMessages).toHaveBeenCalled();
  });

  it('rejects dropped outer-session forwarding even when scope resolution remains correct', async () => {
    buildPayload.mockImplementation((...args) => {
      const payload = payloadCore.buildGptDispatchPayload(...args);
      if (isRecord(payload)) delete payload.sessionId;
      return payload;
    });
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects metadata being promoted to an explicit conversation scope', async () => {
    resolveScope.mockImplementation((body, payload) => {
      const actualScope = scopePolicy.resolveExplicitSessionContextId(body, payload);
      if (actualScope) return actualScope;
      for (const candidate of [body, payload]) {
        if (isRecord(candidate) && isRecord(candidate.metadata)
          && typeof candidate.metadata.sessionId === 'string') return candidate.metadata.sessionId;
      }
      return undefined;
    });
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects unescaped historical closing delimiters', async () => {
    renderHistory.mockImplementation((...args) => {
      const history = renderingCore.buildSessionContextFromStoredTurns(...args);
      return {
        ...history,
        renderedContext: history.renderedContext.replaceAll('\\u003c', '<').replaceAll('\\u003e', '>'),
      };
    });
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects historical text promoted to a system message', async () => {
    contextMessages.mockImplementation(() => contextRuntime.buildSessionContextMessages()
      .map(message => ({ ...message, role: 'system' as 'user' })));
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects empty scopes inheriting another request context', async () => {
    runWithContext.mockImplementation((context, operation) => contextRuntime.runWithSessionContext(
      context ?? contextRuntime.readSessionContext(), operation,
    ));
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects history being reflected into the current module prompt', async () => {
    buildPayload.mockImplementation((...args) => {
      const payload = payloadCore.buildGptDispatchPayload(...args);
      if (isRecord(payload) && typeof payload.prompt === 'string') {
        payload.prompt += contextRuntime.readSessionContext() ?? '';
      }
      return payload;
    });
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('rejects mutation of original caller data while normalization otherwise succeeds', async () => {
    buildPayload.mockImplementation((body, ...rest) => {
      if (isRecord(body)) body.requestId = 'synthetic-unexpected-mutation';
      return payloadCore.buildGptDispatchPayload(body, ...rest);
    });
    await expect(runSessionContextPreviewContract()).rejects.toThrow(FAILURE);
  });

  it('replaces internal failures with the fixed fixture error', async () => {
    buildPayload.mockImplementation(() => { throw new Error('Synthetic internal detail must not be reflected.'); });
    await expect(runSessionContextPreviewContract()).rejects.toMatchObject({ message: FAILURE });
  });
});
