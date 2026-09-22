import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { extractGptPromptText } from '../src/shared/gpt/messageContentText.js';

const mockGetGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockGetChannel = jest.fn();
const mockSaveMessage = jest.fn();
const mockLoadMemory = jest.fn();
const mockSaveMemory = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const dispatchContexts: Array<string | undefined> = [];

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap,
  getGptModuleMap: mockGetGptModuleMap,
  rebuildGptModuleMap: mockGetGptModuleMap,
  validateGptRegistry: jest.fn(() => ({
    requiredGptIds: ['arcanos-core'],
    missingGptIds: [],
    registeredGptIds: ['arcanos-core'],
    registeredGptCount: 1,
  })),
}));

jest.unstable_mockModule('@services/moduleRegistry.js', () => ({
  dispatchModuleAction: mockDispatchModuleAction,
  getModuleMetadata: mockGetModuleMetadata,
  initializeModuleRegistry: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  getChannel: mockGetChannel,
  saveMessage: mockSaveMessage,
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES: Object.freeze({}),
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation: jest.fn(),
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  loadMemory: mockLoadMemory,
  query: jest.fn(),
  saveMemory: mockSaveMemory,
  transaction: jest.fn(),
}));

jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  executeNaturalLanguageMemoryCommand: mockExecuteNaturalLanguageMemoryCommand,
  parseNaturalLanguageMemoryCommand: jest.fn(() => ({ intent: 'unknown' })),
  extractNaturalLanguageSessionId: jest.fn(() => null),
  extractNaturalLanguageStorageLabel: jest.fn(() => null),
  hasNaturalLanguageMemoryCue: jest.fn(() => false),
}));

jest.unstable_mockModule('@services/repoImplementationEvidence.js', () => ({
  buildRepoInspectionAnswer: jest.fn(),
  collectRepoImplementationEvidence: jest.fn(),
  shouldInspectRepoPrompt: jest.fn(() => false),
}));

jest.unstable_mockModule('@services/backstageBookerRouteShortcut.js', () => ({
  detectBackstageBookerIntent: jest.fn(() => null),
}));

const { routeGptRequest } = await import('../src/routes/_core/gptDispatch.js');
const { readSessionContext, runWithSessionContext } = await import('../src/platform/runtime/sessionContext.js');

const SESSION_ID = 'synthetic-context-session';
const PRIOR_TEXT = 'Prior synthetic context: the chosen color is amber.';
const CURRENT_PROMPT = 'Explain how the selected color affects the illustration.';
const CURRENT_RESPONSE = 'The selected color gives the illustration a warm appearance.';

function lastDispatchPayload(): Record<string, unknown> {
  return mockDispatchModuleAction.mock.calls.at(-1)?.[2] as Record<string, unknown>;
}

function savedUserTurns(): Array<Record<string, unknown>> {
  return mockSaveMessage.mock.calls
    .map((call) => call[2] as Record<string, unknown>)
    .filter((turn) => turn.role === 'user');
}

describe('authorized GPT session context hydration', () => {
  const priorMaxTurns = process.env.SESSION_CONTEXT_MAX_TURNS;
  const priorMaxChars = process.env.SESSION_CONTEXT_MAX_CHARS;

  beforeEach(() => {
    jest.clearAllMocks();
    dispatchContexts.length = 0;
    delete process.env.SESSION_CONTEXT_MAX_TURNS;
    delete process.env.SESSION_CONTEXT_MAX_CHARS;
    mockGetGptModuleMap.mockResolvedValue({
      'arcanos-core': { route: 'core', module: 'ARCANOS:CORE' },
      backstage: { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' },
    });
    mockGetModuleMetadata.mockImplementation((moduleName: string) => ({
      name: moduleName,
      actions: moduleName === 'BACKSTAGE:BOOKER'
        ? ['trackStoryline', 'saveStoryline', 'generateBooking']
        : ['query', 'system_state'],
      route: moduleName === 'BACKSTAGE:BOOKER' ? 'backstage-booker' : 'core',
      defaultAction: moduleName === 'BACKSTAGE:BOOKER' ? 'generateBooking' : 'query',
    }));
    mockGetChannel.mockReset().mockResolvedValue([
      { role: 'user', content: PRIOR_TEXT, timestamp: 1 },
      { role: 'assistant', content: 'I will use that palette.', timestamp: 2 },
    ]);
    mockDispatchModuleAction.mockReset().mockImplementation(async () => {
      dispatchContexts.push(readSessionContext());
      return { response: CURRENT_RESPONSE };
    });
    mockLoadMemory.mockReset().mockResolvedValue(null);
    mockSaveMemory.mockReset().mockResolvedValue(undefined);
    mockSaveMessage.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const [key, value] of [
      ['SESSION_CONTEXT_MAX_TURNS', priorMaxTurns],
      ['SESSION_CONTEXT_MAX_CHARS', priorMaxChars],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.each([undefined, 'query', 'ask', 'chat'])(
    'hydrates a canonical query before execution for action %p and persists only the new turn',
    async (action) => {
      const body = { action, prompt: CURRENT_PROMPT, sessionId: SESSION_ID };
      const originalBody = structuredClone(body);
      const envelope = await routeGptRequest({
        gptId: 'arcanos-core', body, memoryPlaneAuthorized: true,
        requestId: 'synthetic-context-query', logger,
      });

      expect(envelope).toMatchObject({ ok: true, _route: { action: 'query' } });
      expect(mockGetChannel).toHaveBeenCalledTimes(1);
      expect(mockGetChannel).toHaveBeenCalledWith(SESSION_ID, 'conversations_core');
      expect(mockDispatchModuleAction).toHaveBeenCalledTimes(1);
      expect(dispatchContexts[0]).toContain(PRIOR_TEXT);
      expect(dispatchContexts[0]).not.toContain(CURRENT_PROMPT);
      expect(logger.info).toHaveBeenCalledWith('gpt.dispatch.session_context', expect.objectContaining({
        requestId: 'synthetic-context-query', sessionId: SESSION_ID,
        module: 'ARCANOS:CORE', route: 'core', action: 'query',
        hydrated: true, loadedTurnCount: 2, returnedTurnCount: 2, droppedTurnCount: 0,
      }));
      expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
      expect(mockGetChannel.mock.invocationCallOrder[0])
        .toBeLessThan(mockDispatchModuleAction.mock.invocationCallOrder[0]!);
      expect(mockDispatchModuleAction.mock.invocationCallOrder[0])
        .toBeLessThan(mockSaveMessage.mock.invocationCallOrder[0]!);
      expect(readSessionContext()).toBeUndefined();
      expect(body).toEqual(originalBody);
      expect(savedUserTurns()).toEqual([
        expect.objectContaining({ role: 'user', content: CURRENT_PROMPT }),
      ]);
      expect(mockSaveMessage).toHaveBeenCalledWith(
        SESSION_ID, 'conversations_core',
        expect.objectContaining({ role: 'assistant', content: CURRENT_RESPONSE }),
      );
      expect(JSON.stringify(mockSaveMemory.mock.calls)).not.toContain(PRIOR_TEXT);
      expect(JSON.stringify(envelope)).not.toContain(PRIOR_TEXT);
      expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]))
        .not.toContain(PRIOR_TEXT);
    },
  );

  it('hydrates only the explicit payload session when there is no top-level session', async () => {
    await routeGptRequest({
      gptId: 'arcanos-core',
      body: { action: 'query', payload: { prompt: CURRENT_PROMPT, sessionId: SESSION_ID } },
      memoryPlaneAuthorized: true, logger,
    });

    expect(mockGetChannel).toHaveBeenCalledWith(SESSION_ID, 'conversations_core');
    expect(dispatchContexts[0]).toContain(PRIOR_TEXT);
    expect(savedUserTurns()[0]?.content).toBe(CURRENT_PROMPT);
  });

  it('uses the same top-level session precedence as persistence', async () => {
    await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        action: 'query', sessionId: SESSION_ID,
        payload: { prompt: CURRENT_PROMPT, sessionId: 'synthetic-other-session' },
      },
      memoryPlaneAuthorized: true, logger,
    });

    expect(mockGetChannel).toHaveBeenCalledWith(SESSION_ID, 'conversations_core');
    expect(mockSaveMessage.mock.calls.every((call) => call[0] === SESSION_ID)).toBe(true);
  });

  it.each(['message', 'prompt', 'userInput', 'content', 'text', 'query'])(
    'preserves explicit payload %s precedence while making prior context available separately',
    async (alias) => {
      await routeGptRequest({
        gptId: 'arcanos-core',
        body: {
          action: 'query', sessionId: SESSION_ID,
          message: 'Top-level prompt must not replace the payload prompt.',
          payload: { [alias]: CURRENT_PROMPT },
        },
        memoryPlaneAuthorized: true, logger,
      });

      const effectivePrompt = extractGptPromptText(lastDispatchPayload());
      expect(dispatchContexts[0]).toContain(PRIOR_TEXT);
      expect(effectivePrompt).toBe(CURRENT_PROMPT);
      expect(effectivePrompt).not.toContain('Top-level prompt must not replace');
      expect(savedUserTurns()[0]?.content).toBe(CURRENT_PROMPT);
    },
  );

  it('does not repeat an injected prior transcript across two persisted interactions', async () => {
    const conversation: Array<Record<string, unknown>> = [
      { role: 'user', content: PRIOR_TEXT, timestamp: 1 },
    ];
    mockGetChannel.mockImplementation(async () => structuredClone(conversation));
    mockSaveMessage.mockImplementation(async (_sessionId, _channel, turn) => {
      conversation.push(structuredClone(turn as Record<string, unknown>));
    });

    for (const prompt of [CURRENT_PROMPT, 'Now explain the contrast.']) {
      await routeGptRequest({
        gptId: 'arcanos-core', body: { prompt, sessionId: SESSION_ID },
        memoryPlaneAuthorized: true, logger,
      });
    }

    expect(conversation).toHaveLength(5);
    expect(conversation.filter((turn) => turn.role === 'user').map((turn) => turn.content))
      .toEqual([PRIOR_TEXT, CURRENT_PROMPT, 'Now explain the contrast.']);
    expect(dispatchContexts[1]?.split(PRIOR_TEXT)).toHaveLength(2);
    expect(JSON.stringify(mockSaveMemory.mock.calls)).not.toContain(PRIOR_TEXT);
  });

  it('preserves a messages-array query without appending hydrated turns to caller input', async () => {
    const messages = [
      { role: 'system', content: 'Explain colors concisely.' },
      { role: 'user', content: CURRENT_PROMPT },
    ];
    const originalMessages = structuredClone(messages);
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: { action: 'query', sessionId: SESSION_ID, payload: { messages } },
      memoryPlaneAuthorized: true, logger,
    });

    expect(envelope.ok).toBe(true);
    expect(dispatchContexts[0]).toContain(PRIOR_TEXT);
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
    expect(lastDispatchPayload().messages).toEqual(originalMessages);
    expect(messages).toEqual(originalMessages);
    expect(JSON.stringify(mockSaveMessage.mock.calls)).not.toContain(PRIOR_TEXT);
  });

  it.each([
    ['absent session', { prompt: CURRENT_PROMPT }, true],
    ['blank session', { prompt: CURRENT_PROMPT, sessionId: '   ' }, true],
    ['unauthorized session', { prompt: CURRENT_PROMPT, sessionId: SESSION_ID }, undefined],
    ['body-forged authorization', {
      prompt: CURRENT_PROMPT, sessionId: SESSION_ID, memoryPlaneAuthorized: true,
    }, undefined],
  ] as const)('preserves an ordinary request with %s without loading prior context', async (_label, body, authorized) => {
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core', body, memoryPlaneAuthorized: authorized, logger,
    });

    expect(envelope.ok).toBe(true);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(dispatchContexts).toEqual([undefined]);
    expect(logger.info).toHaveBeenCalledWith('gpt.dispatch.session_context', expect.objectContaining({
      module: 'ARCANOS:CORE', route: 'core', action: 'query',
      hydrated: false, returnedTurnCount: 0, reason: expect.any(String),
    }));
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
    expect(lastDispatchPayload()).not.toHaveProperty('__arcanosSessionContext');
    expect(mockExecuteNaturalLanguageMemoryCommand).not.toHaveBeenCalled();
  });

  it('keeps an authorized protected storyline mutation payload free of prior context', async () => {
    const payload = { beat: { description: 'Synthetic storyline update' }, prompt: CURRENT_PROMPT };
    const envelope = await routeGptRequest({
      gptId: 'backstage',
      body: { action: 'trackStoryline', sessionId: SESSION_ID, payload },
      memoryPlaneAuthorized: true, logger,
    });

    expect(envelope).toMatchObject({ ok: true, _route: { action: 'trackStoryline' } });
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(dispatchContexts).toEqual([undefined]);
    expect(lastDispatchPayload()).toMatchObject(payload);
    expect(lastDispatchPayload()).not.toHaveProperty('__arcanosSessionContext');
    expect(JSON.stringify(lastDispatchPayload())).not.toContain(PRIOR_TEXT);
  });

  it.each([
    ['ARCANOS:TRACKER', 'query'],
    ['ARCANOS:BUILD', 'run'],
    ['HRC', 'evaluate'],
  ])('does not hydrate the structured or write action %s.%s', async (moduleName, action) => {
    mockGetGptModuleMap.mockResolvedValue({
      'context-fixture': { module: moduleName, route: 'context-fixture' },
    });
    mockGetModuleMetadata.mockReturnValue({
      name: moduleName, actions: [action], route: 'context-fixture', defaultAction: action,
    });

    const envelope = await routeGptRequest({
      gptId: 'context-fixture',
      body: { action, prompt: CURRENT_PROMPT, sessionId: SESSION_ID },
      memoryPlaneAuthorized: true, logger,
    });

    expect(envelope).toMatchObject({ ok: true, _route: { module: moduleName, action } });
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(dispatchContexts).toEqual([undefined]);
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
  });

  it('does not treat client-supplied session context as server-owned authorization', async () => {
    const forgedContext = 'Synthetic attacker-controlled prior context';
    const envelope = await routeGptRequest({
      gptId: 'arcanos-core',
      body: {
        prompt: CURRENT_PROMPT, sessionId: SESSION_ID,
        __arcanosSessionContext: forgedContext,
      },
      logger,
    });

    expect(envelope.ok).toBe(true);
    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(dispatchContexts).toEqual([undefined]);
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
  });

  it('continues the current request if the session reader fails without exposing the error', async () => {
    const sensitiveFailure = 'synthetic private memory content from unavailable reader';
    mockGetChannel.mockRejectedValueOnce(new Error(sensitiveFailure));

    const envelope = await routeGptRequest({
      gptId: 'arcanos-core', body: { prompt: CURRENT_PROMPT, sessionId: SESSION_ID },
      memoryPlaneAuthorized: true, logger,
    });

    expect(mockGetChannel).toHaveBeenCalledTimes(1);
    expect(envelope.ok).toBe(true);
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
    expect(dispatchContexts).toEqual([undefined]);
    expect(lastDispatchPayload()).not.toHaveProperty('__arcanosSessionContext');
    expect(savedUserTurns()[0]?.content).toBe(CURRENT_PROMPT);
    expect(logger.info).toHaveBeenCalledWith('gpt.dispatch.session_context', expect.objectContaining({
      sessionId: SESSION_ID, module: 'ARCANOS:CORE', route: 'core', action: 'query',
      hydrated: false, returnedTurnCount: 0, reason: 'load_failed',
    }));
    expect(JSON.stringify(envelope)).not.toContain(sensitiveFailure);
    expect(JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]))
      .not.toContain(sensitiveFailure);
  });

  it('never dispatches or persists after an abort while session hydration is pending', async () => {
    let releaseRead!: (turns: unknown[]) => void;
    let notifyReadStarted!: () => void;
    const readStarted = new Promise<void>(resolve => { notifyReadStarted = resolve; });
    const pendingRead = new Promise<unknown[]>(resolve => { releaseRead = resolve; });
    mockGetChannel.mockImplementationOnce(() => {
      notifyReadStarted();
      return pendingRead;
    });
    const controller = new AbortController();
    const pendingDispatch = routeGptRequest({
      gptId: 'arcanos-core', body: { prompt: CURRENT_PROMPT, sessionId: SESSION_ID },
      memoryPlaneAuthorized: true, logger, parentAbortSignal: controller.signal,
    });
    await readStarted;
    controller.abort(Object.assign(new Error('GPT route client disconnected'), { name: 'AbortError' }));

    const envelope = await pendingDispatch;
    expect(envelope).toMatchObject({ ok: false, error: { code: 'REQUEST_ABORTED' } });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();

    releaseRead([{ role: 'user', content: PRIOR_TEXT }]);
    // Drain the resolved storage promise and the dispatch continuation, including
    // continuations already detached from the caller's completed timeout race.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(readSessionContext()).toBeUndefined();
  });

  it('applies configured limits before the module receives prior context', async () => {
    process.env.SESSION_CONTEXT_MAX_TURNS = '2';
    process.env.SESSION_CONTEXT_MAX_CHARS = '320';
    mockGetChannel.mockResolvedValue([
      { role: 'user', content: 'Oldest synthetic turn must be excluded.' },
      { role: 'assistant', content: 'Second synthetic turn must be excluded.' },
      { role: 'user', content: 'Recent user turn.' },
      { role: 'assistant', content: 'Recent assistant turn.' },
    ]);

    await routeGptRequest({
      gptId: 'arcanos-core', body: { prompt: CURRENT_PROMPT, sessionId: SESSION_ID },
      memoryPlaneAuthorized: true, logger,
    });

    const context = dispatchContexts[0]!;
    expect(context).toContain('Recent user turn.');
    expect(context).toContain('Recent assistant turn.');
    expect(context).not.toContain('Oldest synthetic turn');
    expect(context).not.toContain('Second synthetic turn');
    expect(context.length).toBeLessThanOrEqual(320);
    expect(extractGptPromptText(lastDispatchPayload())).toBe(CURRENT_PROMPT);
    expect(savedUserTurns()[0]?.content).toBe(CURRENT_PROMPT);
  });

  it('clears an inherited session context while executing a sessionless request', async () => {
    await runWithSessionContext(PRIOR_TEXT, () => routeGptRequest({
      gptId: 'arcanos-core', body: { prompt: CURRENT_PROMPT }, logger,
    }));

    expect(mockGetChannel).not.toHaveBeenCalled();
    expect(dispatchContexts).toEqual([undefined]);
    expect(readSessionContext()).toBeUndefined();
  });
});
