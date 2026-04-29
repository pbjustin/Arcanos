import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getWorkerControlStatusMock = jest.fn();
const getWorkerControlHealthMock = jest.fn();
const getLatestWorkerJobDetailMock = jest.fn();
const getWorkerJobDetailByIdMock = jest.fn();
const queueWorkerAskMock = jest.fn();
const dispatchWorkerInputMock = jest.fn();
const healWorkerRuntimeMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini')
}));

jest.unstable_mockModule('@shared/tokenParameterHelper.js', () => ({
  getTokenParameter: jest.fn(() => ({ max_output_tokens: 256 }))
}));

jest.unstable_mockModule('@config/openaiStore.js', () => ({
  shouldStoreOpenAIResponses: jest.fn(() => false)
}));

jest.unstable_mockModule('@arcanos/openai/responseParsing', () => ({
  extractResponseOutputText: jest.fn((response: { output_text?: string }, fallback: string) => response.output_text || fallback)
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  getWorkerControlStatus: getWorkerControlStatusMock,
  getWorkerControlHealth: getWorkerControlHealthMock,
  getLatestWorkerJobDetail: getLatestWorkerJobDetailMock,
  getWorkerJobDetailById: getWorkerJobDetailByIdMock,
  queueWorkerAsk: queueWorkerAskMock,
  dispatchWorkerInput: dispatchWorkerInputMock,
  healWorkerRuntime: healWorkerRuntimeMock
}));

const { tryDispatchWorkerTools } = await import('../src/routes/ask/workerTools.js');

describe('tryDispatchWorkerTools', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getWorkerControlHealthMock.mockResolvedValue({
      overallStatus: 'healthy',
      alerts: [],
      workers: []
    });
    healWorkerRuntimeMock.mockResolvedValue({
      requestedForce: true,
      restart: {
        started: true,
        message: 'Workers restarted.'
      },
      runtime: {
        started: true
      }
    });
  });

  it('executes deterministic worker operations for common operator prompts', async () => {
    getWorkerControlStatusMock.mockResolvedValue({
      timestamp: '2026-03-06T12:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'worker-helper',
        runtime: {
          started: true,
          activeListeners: 2
        }
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: true,
          hasPool: true,
          error: null
        },
        queueSummary: {
          pending: 1,
          running: 0,
          failed: 0,
          delayed: 0,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 0
        },
        latestJob: null,
        health: {
          overallStatus: 'healthy',
          alerts: [],
          workers: []
        }
      }
    });
    getLatestWorkerJobDetailMock.mockResolvedValue({
      id: 'job-123',
      worker_id: 'worker-helper',
      job_type: 'ask',
      status: 'completed',
      created_at: '2026-03-06T12:00:00.000Z',
      updated_at: '2026-03-06T12:00:05.000Z',
      completed_at: '2026-03-06T12:00:05.000Z',
      error_message: null,
      output: { result: 'completed' }
    });

    const response = await tryDispatchWorkerTools(
      {} as any,
      'show me worker status and latest worker job'
    );

    expect(getWorkerControlStatusMock).toHaveBeenCalledTimes(1);
    expect(getLatestWorkerJobDetailMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual(
      expect.objectContaining({
        module: 'worker-tools',
        result: expect.stringContaining('Worker status:')
      })
    );
    expect(response?.result).toContain('Job status: id=job-123');
  });

  it('does not execute deterministic queue or dispatch mutations without a privileged gate', async () => {
    const response = await tryDispatchWorkerTools(
      {
        responses: {
          create: jest.fn().mockResolvedValue({
            id: 'resp-readonly-mutation',
            model: 'gpt-4.1-mini',
            output: [],
            output_text: ''
          })
        }
      } as any,
      'queue: explain this stack trace\n dispatch: run this now'
    );

    expect(response).toBeNull();
    expect(queueWorkerAskMock).not.toHaveBeenCalled();
    expect(dispatchWorkerInputMock).not.toHaveBeenCalled();
  });

  it('executes deterministic worker mutations only when a privileged gate is supplied', async () => {
    queueWorkerAskMock.mockResolvedValue({
      jobId: 'job-queued-1',
      status: 'pending'
    });
    dispatchWorkerInputMock.mockResolvedValue({
      resultCount: 1,
      results: [{ ok: true }]
    });

    const response = await tryDispatchWorkerTools(
      {} as any,
      'queue: explain this stack trace\n dispatch: run this now',
      { allowPrivilegedMutation: true }
    );

    expect(queueWorkerAskMock).toHaveBeenCalledWith(expect.objectContaining({
      prompt: 'explain this stack trace'
    }));
    expect(dispatchWorkerInputMock).toHaveBeenCalledWith(expect.objectContaining({
      input: 'run this now'
    }));
    expect(response).toEqual(expect.objectContaining({
      module: 'worker-tools',
      result: expect.stringContaining('Queued async worker job job-queued-1')
    }));
  });

  it('falls back to OpenAI tool-calling for non-deterministic worker prompts', async () => {
    getWorkerControlStatusMock.mockResolvedValue({
      timestamp: '2026-03-06T12:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'worker-helper',
        runtime: {
          started: true,
          activeListeners: 2
        }
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: true,
          hasPool: true,
          error: null
        },
        queueSummary: {
          pending: 1,
          running: 0,
          failed: 0,
          delayed: 0,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 0
        },
        latestJob: null,
        health: {
          overallStatus: 'healthy',
          alerts: [],
          workers: []
        }
      }
    });

    const createMock = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-1',
        model: 'gpt-4.1-mini',
        output: [
          {
            type: 'function_call',
            name: 'get_worker_status',
            call_id: 'call-1',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        model: 'gpt-4.1-mini',
        output: [],
        output_text: 'Workers are healthy and the queue is clear enough to proceed.'
      });

    const response = await tryDispatchWorkerTools(
      {
        responses: {
          create: createMock
        }
      } as any,
      'inspect worker operations and decide what tool to call'
    );

    expect(getWorkerControlStatusMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({
            type: 'function',
            name: 'get_worker_status'
          })
        ])
      })
    );
    expect(createMock.mock.calls[1]?.[0]?.previous_response_id).toBeUndefined();
    expect(createMock.mock.calls[1]?.[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'inspect worker operations and decide what tool to call'
        }),
        expect.objectContaining({
          type: 'function_call',
          name: 'get_worker_status',
          call_id: 'call-1'
        }),
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-1'
        })
      ])
    );
    expect(response).toEqual(
      expect.objectContaining({
        module: 'worker-tools',
        result: 'Workers are healthy and the queue is clear enough to proceed.'
      })
    );
  });

  it('binds responses.create so SDK-style methods keep their resource context', async () => {
    getWorkerControlStatusMock.mockResolvedValue({
      timestamp: '2026-03-06T12:00:00.000Z',
      mainApp: {
        connected: true,
        workerId: 'worker-helper',
        runtime: {
          started: true,
          activeListeners: 2
        }
      },
      workerService: {
        observationMode: 'queue-observed',
        database: {
          connected: true,
          hasPool: true,
          error: null
        },
        queueSummary: {
          pending: 1,
          running: 0,
          failed: 0,
          delayed: 0,
          stalledRunning: 0,
          oldestPendingJobAgeMs: 0
        },
        latestJob: null,
        health: {
          overallStatus: 'healthy',
          alerts: [],
          workers: []
        }
      }
    });

    const responsesResource = {
      _client: {
        callCount: 0
      },
      async create(_payload: Record<string, unknown>) {
        this._client.callCount += 1;

        if (this._client.callCount === 1) {
          return {
            id: 'resp-bind-1',
            model: 'gpt-4.1-mini',
            output: [
              {
                type: 'function_call',
                name: 'get_worker_status',
                call_id: 'call-bind-1',
                arguments: '{}'
              }
            ]
          };
        }

        return {
          id: 'resp-bind-2',
          model: 'gpt-4.1-mini',
          output: [],
          output_text: 'Bound create method preserved OpenAI resource context.'
        };
      }
    };

    const response = await tryDispatchWorkerTools(
      {
        responses: responsesResource
      } as any,
      'inspect worker operations and decide what tool to call'
    );

    expect(responsesResource._client.callCount).toBe(2);
    expect(response).toEqual(
      expect.objectContaining({
        module: 'worker-tools',
        result: 'Bound create method preserved OpenAI resource context.'
      })
    );
  });

  it('does not expose or execute model-selected worker runtime heal without an explicit gate', async () => {
    const createMock = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-heal-1',
        model: 'gpt-4.1-mini',
        output: [
          {
            type: 'function_call',
            name: 'heal_worker_runtime',
            call_id: 'call-heal-1',
            arguments: '{"force":true}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-heal-2',
        model: 'gpt-4.1-mini',
        output: [],
        output_text: 'Worker heal was not executed.'
      });

    const response = await tryDispatchWorkerTools(
      {
        responses: {
          create: createMock
        }
      } as any,
      'inspect worker operations and decide what tool to call'
    );

    expect(createMock.mock.calls[0]?.[0]?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'heal_worker_runtime'
        })
      ])
    );
    expect(createMock.mock.calls[1]?.[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-heal-1',
          output: expect.stringContaining('explicit operator gate')
        })
      ])
    );
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
    expect(response).toEqual(expect.objectContaining({
      module: 'worker-tools',
      result: 'Worker heal was not executed.'
    }));
  });

  it('does not expose or execute model-selected worker queue mutations without a privileged gate', async () => {
    const createMock = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-queue-1',
        model: 'gpt-4.1-mini',
        output: [
          {
            type: 'function_call',
            name: 'queue_worker_ask',
            call_id: 'call-queue-1',
            arguments: '{"prompt":"run this in background"}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-queue-2',
        model: 'gpt-4.1-mini',
        output: [],
        output_text: 'Worker queue mutation was not executed.'
      });

    const response = await tryDispatchWorkerTools(
      {
        responses: {
          create: createMock
        }
      } as any,
      'inspect worker operations and decide what tool to call'
    );

    expect(createMock.mock.calls[0]?.[0]?.tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'queue_worker_ask'
        }),
        expect.objectContaining({
          name: 'dispatch_worker_task'
        })
      ])
    );
    expect(createMock.mock.calls[1]?.[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call_output',
          call_id: 'call-queue-1',
          output: expect.stringContaining('explicit operator gate')
        })
      ])
    );
    expect(queueWorkerAskMock).not.toHaveBeenCalled();
    expect(response).toEqual(expect.objectContaining({
      module: 'worker-tools',
      result: 'Worker queue mutation was not executed.'
    }));
  });

  it('requires explicit confirmation language before deterministic worker heal runs', async () => {
    const ungatedResponse = await tryDispatchWorkerTools(
      {
        responses: {
          create: jest.fn().mockResolvedValue({
            id: 'resp-no-heal',
            model: 'gpt-4.1-mini',
            output: [],
            output_text: ''
          })
        }
      } as any,
      'restart the worker runtime'
    );

    expect(ungatedResponse).toBeNull();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();

    const gatedResponse = await tryDispatchWorkerTools(
      {} as any,
      'confirm restart the worker runtime',
      { allowPrivilegedMutation: true }
    );

    expect(healWorkerRuntimeMock).toHaveBeenCalledWith(true, 'ask_tool');
    expect(gatedResponse).toEqual(expect.objectContaining({
      module: 'worker-tools',
      result: expect.stringContaining('Worker heal completed')
    }));
  });
});
