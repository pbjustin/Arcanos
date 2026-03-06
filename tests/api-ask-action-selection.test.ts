import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { sendInternalErrorPayload } from '@shared/http/index.js';

const mockGetGptModuleMap = jest.fn();
const mockGetModuleMetadata = jest.fn();
const mockDispatchModuleAction = jest.fn();
const mockPersistModuleConversation = jest.fn();
const mockParseNaturalLanguageMemoryCommand = jest.fn();
const mockExecuteNaturalLanguageMemoryCommand = jest.fn();

jest.unstable_mockModule('@platform/runtime/gptRouterConfig.js', () => ({
  default: mockGetGptModuleMap
}));

jest.unstable_mockModule('../src/routes/modules.js', () => ({
  getModuleMetadata: mockGetModuleMetadata,
  dispatchModuleAction: mockDispatchModuleAction
}));

jest.unstable_mockModule('@services/moduleConversationPersistence.js', () => ({
  persistModuleConversation: mockPersistModuleConversation
}));

jest.unstable_mockModule('@services/naturalLanguageMemory.js', () => ({
  parseNaturalLanguageMemoryCommand: mockParseNaturalLanguageMemoryCommand,
  executeNaturalLanguageMemoryCommand: mockExecuteNaturalLanguageMemoryCommand
}));

const { default: apiAskRouter } = await import('../src/routes/api-ask.js');

function createApiAskTestApp(): Express {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(apiAskRouter);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message = err instanceof Error ? err.message : 'Internal Server Error';
    sendInternalErrorPayload(res, { error: message });
  });

  return app;
}

describe('/api/ask action selection', () => {
  let app: Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApiAskTestApp();
    mockPersistModuleConversation.mockResolvedValue(undefined);
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'unknown' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'save',
      operation: 'saved',
      sessionId: 'test-session',
      message: 'Saved'
    });
    mockGetGptModuleMap.mockResolvedValue({
      tutor: {
        route: 'queryroute',
        module: 'test-module',
        gptId: 'tutor'
      }
    });
    mockDispatchModuleAction.mockResolvedValue({ ok: true });
  });

  it("prefers the 'query' action when available", async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'query', 'analyze']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(200);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'test-module',
      'query',
      expect.objectContaining({ prompt: 'hello world' })
    );
  });

  it('uses the only available action when exactly one action is exposed', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(200);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'test-module',
      'summarize',
      expect.objectContaining({ prompt: 'hello world' })
    );
  });

  it("fails closed when actions are ambiguous and no 'query' action exists", async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'analyze']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'hello world'
    });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain(
      "Ambiguous actions and no default 'query' action found for module test-module"
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('forwards explicit action payload for non-query actions', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['saveStoryline']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      action: 'saveStoryline',
      payload: {
        key: 'raw-2026-03-06',
        storyline: 'Raw recap summary'
      }
    });

    expect(response.status).toBe(200);
    expect(mockDispatchModuleAction).toHaveBeenCalledWith(
      'test-module',
      'saveStoryline',
      {
        key: 'raw-2026-03-06',
        storyline: 'Raw recap summary'
      }
    );
  });

  it('rejects query actions when no prompt text is present', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['query']
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      action: 'query',
      payload: {
        topic: 'no prompt'
      }
    });

    expect(response.status).toBe(400);
    expect(response.body.details).toContain('Query actions require message/prompt (or messages[]).');
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('intercepts explicit memory commands before module dispatch', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['query']
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'save' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'save',
      operation: 'saved',
      sessionId: 'booker-thread-1',
      key: 'nl-memory:booker-thread-1:entry',
      message: 'Saved to memory successfully.'
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'remember this monday raw summary',
      sessionId: 'booker-thread-1'
    });

    expect(response.status).toBe(200);
    expect(response.body.result.handledBy).toBe('memory-dispatcher');
    expect(response.body.result.memory).toEqual(
      expect.objectContaining({
        operation: 'saved',
        sessionId: 'booker-thread-1'
      })
    );
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledWith({
      input: 'remember this monday raw summary',
      sessionId: 'booker-thread-1'
    });
  });

  it('handles memory commands even when module actions are otherwise ambiguous', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'analyze']
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'save' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'save',
      operation: 'saved',
      sessionId: 'booker-thread-4',
      key: 'nl-memory:booker-thread-4:entry',
      message: 'Saved to memory successfully.'
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'remember this booking note',
      sessionId: 'booker-thread-4'
    });

    expect(response.status).toBe(200);
    expect(response.body.result.handledBy).toBe('memory-dispatcher');
    expect(response.body.result.memory.operation).toBe('saved');
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('routes lookup-style memory commands when no default module action exists', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'analyze']
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'lookup', queryText: 'raw summary' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'lookup',
      operation: 'searched',
      sessionId: 'booker-thread-5',
      entries: [{ key: 'nl-memory:booker-thread-5:entry' }],
      message: 'Found 1 matching entry.'
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'lookup raw summary',
      sessionId: 'booker-thread-5'
    });

    expect(response.status).toBe(200);
    expect(response.body.result.handledBy).toBe('memory-dispatcher');
    expect(response.body.result.memory.operation).toBe('searched');
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('uses universal global memory session when no sessionId is provided', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['summarize', 'analyze']
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'save' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'save',
      operation: 'saved',
      sessionId: 'global',
      key: 'nl-memory:global:entry',
      message: 'Saved to memory successfully.'
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'remember this as a universal memory'
    });

    expect(response.status).toBe(200);
    expect(response.body.result.handledBy).toBe('memory-dispatcher');
    expect(mockExecuteNaturalLanguageMemoryCommand).toHaveBeenCalledWith({
      input: 'remember this as a universal memory',
      sessionId: 'global'
    });
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });

  it('intercepts lookup commands for query-capable modules to keep memory behavior universal', async () => {
    mockGetModuleMetadata.mockReturnValue({
      name: 'test-module',
      description: null,
      route: 'queryroute',
      actions: ['query']
    });
    mockParseNaturalLanguageMemoryCommand.mockReturnValue({ intent: 'lookup', queryText: 'release notes' });
    mockExecuteNaturalLanguageMemoryCommand.mockResolvedValue({
      intent: 'lookup',
      operation: 'searched',
      sessionId: 'global',
      entries: [{ key: 'nl-memory:global:entry' }],
      message: 'Found 1 matching entry.'
    });

    const response = await request(app).post('/api/ask').send({
      gptId: 'tutor',
      message: 'lookup release notes'
    });

    expect(response.status).toBe(200);
    expect(response.body.result.handledBy).toBe('memory-dispatcher');
    expect(response.body.result.memory.operation).toBe('searched');
    expect(mockDispatchModuleAction).not.toHaveBeenCalled();
  });
});
