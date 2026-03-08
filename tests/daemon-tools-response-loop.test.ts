import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const queueDaemonCommandForInstanceMock = jest.fn();
const getDaemonCommandResultForInstanceMock = jest.fn();
const createPendingDaemonActionsMock = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini')
}));

jest.unstable_mockModule('@shared/tokenParameterHelper.js', () => ({
  getTokenParameter: jest.fn(() => ({ max_output_tokens: 256 }))
}));

jest.unstable_mockModule('@config/openaiStore.js', () => ({
  shouldStoreOpenAIResponses: jest.fn(() => false)
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: jest.fn((name: string, fallback: string) => fallback)
}));

jest.unstable_mockModule('@routes/api-daemon.js', () => ({
  createPendingDaemonActions: createPendingDaemonActionsMock,
  getDaemonCommandResultForInstance: getDaemonCommandResultForInstanceMock,
  queueDaemonCommandForInstance: queueDaemonCommandForInstanceMock
}));

jest.unstable_mockModule('@services/safety/auditEvents.js', () => ({
  emitSafetyAuditEvent: jest.fn()
}));

jest.unstable_mockModule('@arcanos/openai/responseParsing', () => ({
  extractResponseOutputText: jest.fn((response: { output_text?: string }, fallback: string) => response.output_text || fallback)
}));

const { tryDispatchDaemonTools } = await import('../src/routes/ask/daemonTools.js');

describe('daemon tool responses loop', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    queueDaemonCommandForInstanceMock.mockReturnValue('cmd-1');
    getDaemonCommandResultForInstanceMock.mockReturnValue({
      ok: true,
      summary: 'screen captured'
    });
  });

  it('replays local transcript state for stateless responses follow-up turns', async () => {
    const createMock = jest
      .fn()
      .mockResolvedValueOnce({
        id: 'resp-1',
        model: 'gpt-4.1-mini',
        output: [
          {
            type: 'function_call',
            name: 'capture_screen',
            call_id: 'call-1',
            arguments: '{}'
          }
        ]
      })
      .mockResolvedValueOnce({
        id: 'resp-2',
        model: 'gpt-4.1-mini',
        output: [],
        output_text: 'Screen captured successfully.'
      });

    const response = await tryDispatchDaemonTools(
      {
        responses: {
          create: createMock
        }
      } as any,
      'look at my screen',
      {
        source: 'daemon',
        instanceId: 'daemon-instance-1'
      }
    );

    expect(queueDaemonCommandForInstanceMock).toHaveBeenCalledTimes(1);
    expect(createMock.mock.calls[1]?.[0]?.previous_response_id).toBeUndefined();
    expect(createMock.mock.calls[1]?.[0]?.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'look at my screen'
        }),
        expect.objectContaining({
          type: 'function_call',
          name: 'capture_screen',
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
        module: 'daemon-tools',
        result: 'Screen captured successfully.'
      })
    );
  });
});
