import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getWorkerControlStatusMock = jest.fn();
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
  });

  it('returns auth guidance for worker-control prompts without helper auth', async () => {
    const response = await tryDispatchWorkerTools(
      {} as any,
      'restart the workers and show me status',
      { status: 'missing' }
    );

    expect(response).toEqual(
      expect.objectContaining({
        module: 'worker-tools',
        result:
          'Worker control requires x-worker-helper-key, x-admin-api-key, x-register-key, or Authorization: Bearer <key>.'
      })
    );
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
          failed: 0
        },
        latestJob: null
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
      'show me worker status and latest worker job',
      {
        status: 'authorized',
        context: {
          matchedCredential: 'admin',
          headerSource: 'x-worker-helper-key'
        }
      }
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
          failed: 0
        },
        latestJob: null
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
      'inspect worker operations and decide what tool to call',
      {
        status: 'authorized',
        context: {
          matchedCredential: 'admin',
          headerSource: 'x-worker-helper-key'
        }
      }
    );

    expect(getWorkerControlStatusMock).toHaveBeenCalledTimes(1);
    expect(response).toEqual(
      expect.objectContaining({
        module: 'worker-tools',
        result: 'Workers are healthy and the queue is clear enough to proceed.'
      })
    );
  });
});
