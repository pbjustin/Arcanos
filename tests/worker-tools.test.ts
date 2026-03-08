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
});
