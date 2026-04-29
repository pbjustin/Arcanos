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
  TrinityControlLeakError,
  applyTrinityGenerationInvariant
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

    expect(result).toEqual(expect.objectContaining({
      ...trinityResult,
      meta: expect.objectContaining({
        id: 'resp-1',
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'write',
        classification: 'writing'
      })
    }));
    expect(trinityResult.meta).toEqual({ id: 'resp-1', created: expect.any(Number) });
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

  it('treats DAG-like prompt text as writing content unless DAG execution is explicit', async () => {
    const trinityResult = {
      result: 'DAG guidance content',
      module: 'trinity',
      meta: { id: 'resp-dag-content', created: Date.now() },
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
        requestId: 'req-dag-content-1',
        logged: true
      }
    };
    runThroughBrainMock.mockResolvedValue(trinityResult);

    const result = await runTrinityWritingPipeline({
      input: {
        prompt: 'Generate a phased workflow: inventory, classify, refactor, verify, report.',
        sourceEndpoint: 'write',
        body: {
          prompt: 'Generate a phased workflow: inventory, classify, refactor, verify, report.'
        }
      },
      context: {
        client: {} as never,
        requestId: 'req-dag-content-1'
      }
    });

    expect(result).toEqual(expect.objectContaining({
      ...trinityResult,
      meta: expect.objectContaining({
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'write',
        classification: 'writing'
      })
    }));
    expect(runThroughBrainMock).toHaveBeenCalledTimes(1);
    expect(loggerErrorMock).not.toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        classification: 'dag_control'
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

  it('rejects natural-language DAG diagnostic prompts before the Trinity engine executes', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: 'Run live DAG diagnostics and inspect the Trinity worker pipeline status.',
          sourceEndpoint: 'write',
          body: {
            action: 'query_and_wait',
            prompt: 'Run live DAG diagnostics and inspect the Trinity worker pipeline status.'
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-dag-prompt-leak-1'
        }
      })
    ).rejects.toMatchObject({
      name: 'TrinityControlLeakError',
      classification: expect.objectContaining({
        kind: 'dag_control',
        action: 'dag.run.create'
      })
    });

    expect(runThroughBrainMock).not.toHaveBeenCalled();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'trinity.control_leak_detected',
      expect.objectContaining({
        requestId: 'req-dag-prompt-leak-1',
        sourceEndpoint: 'write',
        classification: 'dag_control',
        action: 'dag.run.create'
      })
    );
  });

  it('accepts structured chat messages and resolves them at the facade boundary', async () => {
    runThroughBrainMock.mockResolvedValue({
      result: 'structured chat output',
      module: 'trinity',
      meta: { id: 'resp-messages', created: Date.now() },
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
        requestId: 'req-messages',
        logged: true
      }
    });

    await runTrinityWritingPipeline({
      input: {
        messages: [
          { role: 'system', content: 'Preserve the policy frame.' },
          { role: 'user', content: 'Write the response from these chat messages.' }
        ],
        sourceEndpoint: 'write.messages',
        body: {
          messages: [
            { role: 'system', content: 'Preserve the policy frame.' },
            { role: 'user', content: 'Write the response from these chat messages.' }
          ]
        }
      },
      context: {
        client: {} as never,
        requestId: 'req-messages'
      }
    });

    expect(runThroughBrainMock).toHaveBeenCalledWith(
      expect.anything(),
      '[system]\nPreserve the policy frame.\n\n[user]\nWrite the response from these chat messages.',
      undefined,
      undefined,
      {
        sourceEndpoint: 'write.messages'
      },
      expect.anything()
    );
  });

  it('rejects empty prompt input when no message content can be resolved', async () => {
    await expect(
      runTrinityWritingPipeline({
        input: {
          prompt: '   ',
          messages: [
            { role: 'system', content: '   ' },
            { role: 'user', content: '' }
          ],
          sourceEndpoint: 'write.empty',
          body: {
            prompt: '   ',
            messages: [
              { role: 'system', content: '   ' },
              { role: 'user', content: '' }
            ]
          }
        },
        context: {
          client: {} as never,
          requestId: 'req-empty-prompt'
        }
      })
    ).rejects.toThrow('Trinity generation requires a non-empty prompt or messages array.');

    expect(runThroughBrainMock).not.toHaveBeenCalled();
  });

  it('normalizes fractional token limits to positive integers without mutating the source result', () => {
    const sourceResult = {
      result: 'ok',
      module: 'trinity',
      meta: { id: 'resp-positive', created: 1 },
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
        requestId: 'req-positive',
        logged: true
      }
    };

    const stamped = applyTrinityGenerationInvariant(sourceResult, {
      sourceEndpoint: 'write',
      tokenLimit: 0.5,
      outputLimit: 0.25
    });

    expect(stamped).not.toBe(sourceResult);
    expect(sourceResult.meta).toEqual({ id: 'resp-positive', created: 1 });
    expect(stamped.meta).toEqual(expect.objectContaining({
      pipeline: 'trinity',
      tokenLimit: 1,
      outputLimit: 1
    }));
  });

  it('preserves source meta and clones background metadata into the invariant envelope', () => {
    const background = {
      reason: 'arcanos_core_background',
      requestedBy: 'worker'
    };
    const sourceResult = {
      result: 'ok',
      module: 'trinity',
      meta: {
        id: 'resp-background',
        created: 2,
        existing: 'preserved'
      },
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
        requestId: 'req-background',
        logged: true
      }
    };

    const stamped = applyTrinityGenerationInvariant(sourceResult, {
      sourceEndpoint: 'write.background',
      executionMode: 'background',
      background
    });

    expect(stamped).not.toBe(sourceResult);
    expect(sourceResult.meta).toEqual({
      id: 'resp-background',
      created: 2,
      existing: 'preserved'
    });
    expect(stamped.meta).toEqual(expect.objectContaining({
      id: 'resp-background',
      created: 2,
      existing: 'preserved',
      pipeline: 'trinity',
      sourceEndpoint: 'write.background',
      executionMode: 'background',
      background
    }));
    expect((stamped.meta as Record<string, unknown>).background).not.toBe(background);

    background.reason = 'mutated-after-stamp';
    expect((stamped.meta as { background?: Record<string, unknown> }).background).toEqual({
      reason: 'arcanos_core_background',
      requestedBy: 'worker'
    });
  });
});
