import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const workspaceRoot = 'C:/pbjustin/Arcanos';
let mockedAuditSafeMode: 'true' | 'false' | 'passive' | 'log-only' = 'false';

const mockLogExecution = jest.fn(async () => undefined);
const mockCreateCentralizedCompletion = jest.fn();
const mockGenerateMockResponse = jest.fn(() => ({
  result: 'mocked-ai-response',
  meta: {
    source: 'mock'
  }
}));
const mockHasValidApiKey = jest.fn(() => false);
const mockSetAuditSafeMode = jest.fn((mode: typeof mockedAuditSafeMode) => {
  mockedAuditSafeMode = mode;
});
const mockGetAuditSafeMode = jest.fn(() => mockedAuditSafeMode);
const mockInterpretCommand = jest.fn(async (instruction: string) => {
  if (instruction.toLowerCase().includes('strict')) {
    mockedAuditSafeMode = 'true';
  }
});

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

jest.unstable_mockModule('@services/auditSafeToggle.js', () => ({
  getAuditSafeMode: mockGetAuditSafeMode,
  setAuditSafeMode: mockSetAuditSafeMode,
  interpretCommand: mockInterpretCommand
}));

const {
  executeCommand,
  listAvailableCommands,
  listCommandSchemaCoverage
} = await import('../src/services/commandCenter.js');
const { dispatchAuditSafeHandler } = await import('../src/services/cef/handlers/auditSafe.handler.js');
const { dispatchWhitelistedCefHandler } = await import('../src/services/cef/handlers/index.js');

describe('commandCenter contracts and tracing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedAuditSafeMode = 'false';
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

    expect(listCommandSchemaCoverage()).toEqual({
      'audit-safe:set-mode': {
        inputSchemaName: 'AuditSafeSetModeInputSchema',
        outputSchemaName: 'AuditSafeSetModeOutputSchema',
        errorSchemaName: 'CommandErrorSchema'
      },
      'audit-safe:interpret': {
        inputSchemaName: 'AuditSafeInterpretInputSchema',
        outputSchemaName: 'AuditSafeInterpretOutputSchema',
        errorSchemaName: 'CommandErrorSchema'
      },
      'ai:prompt': {
        inputSchemaName: 'AiPromptInputSchema',
        outputSchemaName: 'AiPromptOutputSchema',
        errorSchemaName: 'CommandErrorSchema'
      }
    });
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
        message: 'Command payload failed schema validation.',
        httpStatusCode: 400
      })
    );
    expect(mockSetAuditSafeMode).not.toHaveBeenCalled();
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
        status: 'error',
        errorCode: 'INVALID_COMMAND_PAYLOAD',
        fallbackUsed: false,
        retryCount: 0,
        domain: 'audit-safe',
        handlerMethod: 'set-mode'
      })
    );
  });

  it('traces command dispatch and handler success across the CEF boundary', async () => {
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
      'cef.dispatch.start',
      'cef.handler.start',
      'cef.handler.success',
      'cef.dispatch.success'
    ]));
  });

  it('traces retry and success after a transient AI failure', async () => {
    mockHasValidApiKey.mockReturnValue(true);
    mockCreateCentralizedCompletion
      .mockRejectedValueOnce(Object.assign(new Error('timeout while calling OpenAI'), { code: 'ETIMEDOUT' }))
      .mockResolvedValueOnce({
        choices: [
          {
            message: {
              content: 'retried-ai-response'
            }
          }
        ],
        usage: {
          total_tokens: 42
        },
        model: 'gpt-test'
      });

    const result = await executeCommand('ai:prompt', { prompt: 'Retry the AI handler once.' }, {
      traceId: 'trace-cef-retry',
      executionId: 'exec-retry',
      stepId: 'step-retry',
      capabilityId: 'goal-fulfillment',
      source: 'test'
    });

    expect(result.success).toBe(true);
    expect(result.output).toEqual(
      expect.objectContaining({
        result: 'retried-ai-response',
        model: 'gpt-test'
      })
    );
    expect(mockCreateCentralizedCompletion).toHaveBeenCalledTimes(2);

    const retryTraceCall = mockLogExecution.mock.calls.find(call => call[2] === 'cef.handler.retry');
    expect(retryTraceCall?.[3]).toEqual(expect.objectContaining({
      traceId: 'trace-cef-retry',
      command: 'ai:prompt',
      handler: 'ai:prompt',
      timestamp: expect.any(String),
      status: 'retry',
      durationMs: expect.any(Number),
      errorCode: 'COMMAND_HANDLER_FAILED',
      retryCount: 1,
      fallbackUsed: false
    }));
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
      'cef.handler.success',
      'cef.dispatch.success'
    ]));

    const fallbackTraceCall = mockLogExecution.mock.calls.find(call => call[2] === 'cef.handler.fallback');
    expect(fallbackTraceCall?.[3]).toEqual(expect.objectContaining({
      traceId: 'trace-cef-fallback',
      command: 'ai:prompt',
      handler: 'ai:prompt',
      timestamp: expect.any(String),
      status: 'fallback',
      durationMs: expect.any(Number),
      errorCode: 'COMMAND_HANDLER_FAILED',
      fallbackUsed: true,
      retryCount: 0
    }));
  });

  it('traces handler errors when fallback execution also fails', async () => {
    mockGenerateMockResponse.mockImplementation(() => {
      throw new Error('mock generation failed');
    });

    const result = await executeCommand('ai:prompt', { prompt: 'Force fallback failure' }, {
      traceId: 'trace-cef-error',
      executionId: 'exec-error',
      stepId: 'step-error',
      capabilityId: 'goal-fulfillment',
      source: 'test'
    });

    expect(result.success).toBe(false);
    expect(result.error).toEqual(
      expect.objectContaining({
        code: 'COMMAND_HANDLER_FAILED',
        httpStatusCode: 500
      })
    );

    const traceMessages = mockLogExecution.mock.calls.map(call => call[2]);
    expect(traceMessages).toEqual(expect.arrayContaining([
      'cef.handler.error',
      'cef.handler.fallback',
      'cef.dispatch.error'
    ]));

    const fallbackErrorTraceCall = mockLogExecution.mock.calls.find(call =>
      call[2] === 'cef.handler.error' && call[3]?.fallbackUsed === true
    );
    expect(fallbackErrorTraceCall?.[3]).toEqual(expect.objectContaining({
      traceId: 'trace-cef-error',
      command: 'ai:prompt',
      handler: 'ai:prompt',
      timestamp: expect.any(String),
      status: 'error',
      durationMs: expect.any(Number),
      errorCode: 'COMMAND_HANDLER_FAILED',
      fallbackUsed: true,
      retryCount: 0
    }));
  });

  it('blocks non-whitelisted handler actions before dispatch', async () => {
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
        code: 'HANDLER_ACTION_NOT_ALLOWED',
        message: 'Handler action is not allowed.',
        httpStatusCode: 403
      })
    );
    expect(mockLogExecution).toHaveBeenCalledWith(
      'cef-boundary',
      'error',
      'cef.handler.error',
      expect.objectContaining({
        command: 'audit-safe:set-mode',
        traceId: 'trace-cef-whitelist',
        status: 'error',
        errorCode: 'HANDLER_ACTION_NOT_ALLOWED',
        attemptedAction: 'delete-all'
      })
    );
  });

  it('fails closed in the explicit handler dispatcher for unknown actions', async () => {
    const result = await dispatchWhitelistedCefHandler({
      name: 'audit-safe:set-mode',
      handlerDomain: 'audit-safe',
      handlerMethod: 'delete-all'
    }, { mode: 'true' }, {
      command: 'audit-safe:set-mode',
      commandTraceId: 'cef-test-handler-index',
      domain: 'audit-safe',
      handlerMethod: 'delete-all',
      traceId: 'trace-cef-handler-index',
      executionId: 'exec-handler-index',
      stepId: 'step-handler-index',
      capabilityId: 'audit-safe-mode-control',
      source: 'test'
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      error: expect.objectContaining({
        code: 'HANDLER_ACTION_NOT_ALLOWED',
        httpStatusCode: 403
      })
    }));
  });

  it('does not leave generic execute(payload) handler entrypoints in the hardened CEF surface', () => {
    const protectedFiles = [
      'src/services/commandCenter.ts',
      'src/services/cef/handlerRuntime.ts',
      'src/services/cef/handlers/index.ts',
      'src/services/cef/handlers/ai.handler.ts',
      'src/services/cef/handlers/auditSafe.handler.ts'
    ];
    const unsafeExecuteSignaturePatterns = [
      /\bexecute\s*\(\s*payload\b/,
      /\bexecute\s*\(\s*args\b/,
      /\bexecute\s*:\s*async\s*\(\s*payload\b/,
      /\bexecute\s*:\s*\(\s*payload\b/
    ];

    for (const relativeFilePath of protectedFiles) {
      const absoluteFilePath = path.join(workspaceRoot, relativeFilePath);
      const fileContents = fs.readFileSync(absoluteFilePath, 'utf8');

      for (const unsafePattern of unsafeExecuteSignaturePatterns) {
        //audit Assumption: CEF hardening removes open-ended execute(payload) dispatch entrypoints from the protected boundary surface; failure risk: a future generic execute slips back in and bypasses allowlists/schema checks; expected invariant: protected CEF files contain no unsafe generic execute signatures; handling strategy: fail the contract test on the first match.
        expect(fileContents).not.toMatch(unsafePattern);
      }
    }
  });
});
