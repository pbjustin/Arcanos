import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runThroughBrainMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerErrorMock = jest.fn();
const createLoggerMock = () => ({
  info: loggerInfoMock,
  warn: jest.fn(),
  error: loggerErrorMock,
  debug: jest.fn(),
  child: () => createLoggerMock()
});

jest.unstable_mockModule('@core/logic/trinity.js', () => ({
  runThroughBrain: runThroughBrainMock
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  sanitize: (value: unknown) => value,
  getConfiguredLogLevel: () => 'info',
  LogLevel: {
    DEBUG: 'debug',
    INFO: 'info',
    WARN: 'warn',
    ERROR: 'error'
  },
  apiLogger: {
    ...createLoggerMock()
  },
  dbLogger: {
    ...createLoggerMock()
  },
  aiLogger: {
    ...createLoggerMock()
  },
  workerLogger: {
    ...createLoggerMock()
  },
  logger: createLoggerMock(),
  requestLoggingMiddleware: jest.fn(),
  healthMetrics: {
    updateFromHealthCheck: jest.fn(),
    getSnapshot: jest.fn(() => ({}))
  },
  default: createLoggerMock()
}));

const {
  runTrinityWritingPipeline,
  TrinityControlLeakError
} = await import('../src/core/logic/trinityWritingPipeline.js');

describe('runTrinityWritingPipeline', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('executes the low-level Trinity engine only for validated writing input', async () => {
    const client = { id: 'openai-client' } as never;
    const runtimeBudget = { budgetId: 'runtime-budget' } as never;
    const trinityResult = {
      result: 'structured writing output',
      module: 'trinity',
      meta: { id: 'resp-1', created: Date.now() },
      activeModel: 'gpt-5.1',
      fallbackFlag: false,
      dryRun: false,
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: []
      },
      auditSafe: {
        mode: true,
        overrideUsed: false,
        auditFlags: [],
        processedSafely: true
      },
      memoryContext: {
        entriesAccessed: 0,
        contextSummary: '',
        memoryEnhanced: false,
        maxRelevanceScore: 0,
        averageRelevanceScore: 0
      },
      taskLineage: {
        requestId: 'req-write-1',
        logged: true
      }
    };
    runThroughBrainMock.mockResolvedValue(trinityResult);

    const result = await runTrinityWritingPipeline({
      input: {
        prompt: 'Write a concise release summary.',
        sessionId: 'sess-write-1',
        sourceEndpoint: 'write',
        body: {
          prompt: 'Write a concise release summary.'
        }
      },
      context: {
        client,
        requestId: 'req-write-1',
        runtimeBudget,
        runOptions: {
          answerMode: 'direct'
        }
      }
    });

    expect(result).toBe(trinityResult);
    expect(runThroughBrainMock).toHaveBeenCalledWith(
      client,
      'Write a concise release summary.',
      'sess-write-1',
      undefined,
      {
        answerMode: 'direct',
        sourceEndpoint: 'write'
      },
      runtimeBudget
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'trinity.entry',
      expect.objectContaining({
        requestId: 'req-write-1',
        sourceEndpoint: 'write'
      })
    );
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'trinity.exit',
      expect.objectContaining({
        requestId: 'req-write-1',
        sourceEndpoint: 'write',
        activeModel: 'gpt-5.1'
      })
    );
  });

  it('generates a unique request id when no explicit request id is provided', async () => {
    runThroughBrainMock.mockResolvedValue({
      result: 'ok',
      module: 'trinity',
      meta: { id: 'resp-2', created: Date.now() },
      activeModel: 'gpt-5.1',
      fallbackFlag: false,
      dryRun: false,
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: []
      },
      auditSafe: {
        mode: true,
        overrideUsed: false,
        auditFlags: [],
        processedSafely: true
      },
      memoryContext: {
        entriesAccessed: 0,
        contextSummary: '',
        memoryEnhanced: false,
        maxRelevanceScore: 0,
        averageRelevanceScore: 0
      },
      taskLineage: {
        requestId: 'resp-request',
        logged: true
      }
    });

    await runTrinityWritingPipeline({
      input: {
        prompt: 'Write a short summary.',
        sessionId: 'sess-shared-1',
        sourceEndpoint: 'write',
        body: {
          prompt: 'Write a short summary.'
        }
      },
      context: {
        client: {} as never
      }
    });

    expect(loggerInfoMock).toHaveBeenCalledWith(
      'trinity.entry',
      expect.objectContaining({
        requestId: expect.stringMatching(/^trinity_/),
        sourceEndpoint: 'write'
      })
    );
    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      'trinity.entry',
      expect.objectContaining({
        requestId: 'sess-shared-1'
      })
    );
  });

  it('rejects MCP control leakage before the Trinity engine executes', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: 'List tools',
          requestedAction: 'mcp.invoke',
          sourceEndpoint: 'write',
          body: {
            action: 'mcp.invoke',
            payload: {
              toolName: 'modules.list'
            }
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-mcp-leak-1'
        }
      })
    ).rejects.toBeInstanceOf(TrinityControlLeakError);

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        requestId: 'req-mcp-leak-1',
        sourceEndpoint: 'write',
        classification: 'mcp_control',
        action: 'mcp.invoke'
      })
    );
  });

  it('rejects MCP control leakage when supplied through operation aliases', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: 'List tools',
          sourceEndpoint: 'write',
          body: {
            payload: {
              operation: 'mcp.list-tools'
            }
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-mcp-leak-2'
        }
      })
    ).rejects.toBeInstanceOf(TrinityControlLeakError);

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        requestId: 'req-mcp-leak-2',
        sourceEndpoint: 'write',
        classification: 'mcp_control',
        action: 'mcp.list_tools'
      })
    );
  });

  it('rejects DAG control prompts before the Trinity engine executes', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: 'trigger a real DAG run and trace it live',
          sourceEndpoint: 'write',
          body: {
            prompt: 'trigger a real DAG run and trace it live'
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-dag-leak-1'
        }
      })
    ).rejects.toMatchObject({
      name: 'TrinityControlLeakError',
      classification: expect.objectContaining({
        kind: 'dag_control'
      })
    });

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        requestId: 'req-dag-leak-1',
        sourceEndpoint: 'write',
        classification: 'dag_control',
        action: 'dag.run.create'
      })
    );
  });

  it('rejects explicit embedded DAG control actions before the Trinity engine executes', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: 'run the latest dag trace for me',
          sourceEndpoint: 'write',
          body: {
            prompt: 'run the latest dag trace for me',
            payload: {
              action: 'dag.run.latest'
            }
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-dag-leak-2'
        }
      })
    ).rejects.toMatchObject({
      name: 'TrinityControlLeakError',
      classification: expect.objectContaining({
        kind: 'dag_control',
        action: 'dag.run.latest'
      })
    });

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        requestId: 'req-dag-leak-2',
        sourceEndpoint: 'write',
        classification: 'dag_control',
        action: 'dag.run.latest'
      })
    );
  });
});
