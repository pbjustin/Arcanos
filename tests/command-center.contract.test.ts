import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLogExecution = jest.fn(async () => undefined);
const mockCreateCentralizedCompletion = jest.fn();
const mockGenerateMockResponse = jest.fn(() => ({
  result: 'mocked-ai-response',
  meta: {
    source: 'mock'
  }
}));
const mockHasValidApiKey = jest.fn(() => false);

jest.unstable_mockModule('@core/db/repositories/executionLogRepository.js', () => ({
  logExecution: mockLogExecution
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  createCentralizedCompletion: mockCreateCentralizedCompletion,
  generateMockResponse: mockGenerateMockResponse,
  hasValidAPIKey: mockHasValidApiKey,
  getDefaultModel: () => 'gpt-4.1-mini',
  getFallbackModel: () => 'gpt-4',
  getComplexModel: () => 'gpt-4.1',
  getGPT5Model: () => 'gpt-5',
  getOpenAIServiceHealth: jest.fn(),
  validateAPIKeyAtStartup: jest.fn(),
  callOpenAI: jest.fn(),
  createGPT5Reasoning: jest.fn(),
  createGPT5ReasoningLayer: jest.fn(),
  call_gpt5_strict: jest.fn(),
  generateImage: jest.fn(),
  getCircuitBreakerSnapshot: jest.fn(),
  validateClientHealth: jest.fn(),
  createChatCompletionWithFallback: jest.fn(),
  getOpenAIClient: jest.fn(),
  getOpenAIKeySource: jest.fn(),
  runStructuredReasoning: jest.fn()
}));

const { executeCommand, listAvailableCommands } = await import('../src/services/commandCenter.js');
const { dispatchAuditSafeHandler } = await import('../src/services/cef/handlers/auditSafe.handler.js');

describe('commandCenter contracts and tracing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHasValidApiKey.mockReturnValue(false);
    mockGenerateMockResponse.mockReturnValue({
      result: 'mocked-ai-response',
      meta: {
        source: 'mock'
      }
    });
  });

  it('exposes typed schema names for every registered command', () => {
    const commands = listAvailableCommands();

    expect(commands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'audit-safe:set-mode',
          inputSchemaName: 'AuditSafeSetModeInputSchema',
          outputSchemaName: 'AuditSafeSetModeOutputSchema',
          errorSchemaName: 'CommandErrorSchema',
          handlerDomain: 'audit-safe',
          handlerMethod: 'set-mode'
        }),
        expect.objectContaining({
          name: 'audit-safe:interpret',
          inputSchemaName: 'AuditSafeInterpretInputSchema',
          outputSchemaName: 'AuditSafeInterpretOutputSchema',
          errorSchemaName: 'CommandErrorSchema',
          handlerDomain: 'audit-safe',
          handlerMethod: 'interpret'
        }),
        expect.objectContaining({
          name: 'ai:prompt',
          inputSchemaName: 'AiPromptInputSchema',
          outputSchemaName: 'AiPromptOutputSchema',
          errorSchemaName: 'CommandErrorSchema',
          handlerDomain: 'ai',
          handlerMethod: 'prompt'
        })
      ])
    );
  });

  it('rejects invalid payloads before handler execution and traces the schema failure', async () => {
    const result = await executeCommand('audit-safe:set-mode', { mode: 'invalid-mode' }, {
      traceId: 'trace-cef-invalid',
      executionId: 'exec-invalid',
      stepId: 'step-invalid',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'INVALID_COMMAND_PAYLOAD',
        message: 'Command payload failed schema validation.'
      })
    );
    expect(result.metadata.traceId).toBe('trace-cef-invalid');
    expect(mockLogExecution).toHaveBeenCalledWith(
      'cef-boundary',
      'warn',
      'cef.schema.invalid_payload',
      expect.objectContaining({
        command: 'audit-safe:set-mode',
        traceId: 'trace-cef-invalid',
        executionId: 'exec-invalid',
        capabilityId: 'audit-safe-mode-control',
        stepId: 'step-invalid',
        domain: 'audit-safe',
        handlerMethod: 'set-mode'
      })
    );
  });

  it('traces command and handler success across the CEF boundary', async () => {
    const result = await executeCommand('audit-safe:set-mode', { mode: 'true' }, {
      traceId: 'trace-cef-success',
      executionId: 'exec-success',
      stepId: 'step-success',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual({
      mode: 'true'
    });
    expect(result.error).toBeNull();
    expect(result.metadata.commandTraceId).toMatch(/^cef_/);

    const traceMessages = mockLogExecution.mock.calls.map(call => call[2]);
    expect(traceMessages).toEqual(expect.arrayContaining([
      'cef.command.started',
      'cef.handler.start',
      'cef.handler.success',
      'cef.command.completed'
    ]));
  });

  it('traces handler fallback paths for AI prompt execution', async () => {
    const result = await executeCommand('ai:prompt', { prompt: 'Hello from fallback test' }, {
      traceId: 'trace-cef-fallback',
      executionId: 'exec-fallback',
      stepId: 'step-fallback',
      capabilityId: 'goal-fulfillment',
      source: 'test'
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.objectContaining({
        result: 'mocked-ai-response',
        fallback: true
      })
    );
    expect(mockCreateCentralizedCompletion).not.toHaveBeenCalled();
    expect(mockGenerateMockResponse).toHaveBeenCalled();

    const traceMessages = mockLogExecution.mock.calls.map(call => call[2]);
    expect(traceMessages).toEqual(expect.arrayContaining([
      'cef.handler.start',
      'cef.handler.error',
      'cef.handler.fallback',
      'cef.command.completed'
    ]));
  });

  it('blocks non-whitelisted handler methods before dispatch', async () => {
    const result = await dispatchAuditSafeHandler('delete-all', { mode: 'true' }, {
      command: 'audit-safe:set-mode',
      commandTraceId: 'cef-test-whitelist',
      domain: 'audit-safe',
      handlerMethod: 'delete-all',
      traceId: 'trace-cef-whitelist',
      executionId: 'exec-whitelist',
      stepId: 'step-whitelist',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'HANDLER_METHOD_NOT_ALLOWED',
        message: 'Handler method is not whitelisted.'
      })
    );
    expect(mockLogExecution).toHaveBeenCalledWith(
      'cef-boundary',
      'error',
      'cef.handler.error',
      expect.objectContaining({
        command: 'audit-safe:set-mode',
        attemptedMethod: 'delete-all',
        traceId: 'trace-cef-whitelist'
      })
    );
  });
});
