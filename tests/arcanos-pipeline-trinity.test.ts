import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();
const requireOpenAIClientOrAdapterMock = jest.fn();

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  requireOpenAIClientOrAdapter: requireOpenAIClientOrAdapterMock
}));

const { executeArcanosPipeline } = await import('../src/services/arcanosPipeline.js');

describe('executeArcanosPipeline Trinity orchestration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    requireOpenAIClientOrAdapterMock.mockReturnValue({ client: { responses: {} } });
    runTrinityWritingPipelineMock.mockImplementation(async (request: { input: { body?: { stage?: string } } }) => {
      const stage = request.input.body?.stage ?? 'unknown';
      return {
        result: `${stage}-output`,
        activeModel: `trinity-${stage}`,
        fallbackFlag: false,
        routingStages: [`TRINITY:${stage}`],
        meta: {
          id: `resp-${stage}`,
          created: 1,
          pipeline: 'trinity',
          bypass: false,
          sourceEndpoint: `arcanos-pipeline.${stage}`,
          classification: 'writing'
        }
      };
    });
  });

  it('preserves the legacy multi-stage reasoning chain through Trinity calls', async () => {
    const result = await executeArcanosPipeline([
      { role: 'user', content: 'Draft a migration strategy.' }
    ]);

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledTimes(4);
    expect(runTrinityWritingPipelineMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        input: expect.objectContaining({
          messages: [{ role: 'user', content: 'Draft a migration strategy.' }],
          sourceEndpoint: 'arcanos-pipeline.arc-first'
        })
      })
    );
    expect(runTrinityWritingPipelineMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        input: expect.objectContaining({
          sourceEndpoint: 'arcanos-pipeline.sub-agent',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: 'arc-first-output'
            })
          ])
        })
      })
    );
    expect(runTrinityWritingPipelineMock).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        input: expect.objectContaining({
          sourceEndpoint: 'arcanos-pipeline.overseer',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: 'sub-agent-output'
            })
          ])
        })
      })
    );
    expect(runTrinityWritingPipelineMock).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        input: expect.objectContaining({
          sourceEndpoint: 'arcanos-pipeline.final',
          messages: expect.arrayContaining([
            expect.objectContaining({
              role: 'assistant',
              content: 'overseer-output'
            })
          ])
        })
      })
    );

    expect(result).toEqual(expect.objectContaining({
      fallback: false,
      activeModel: 'trinity-final',
      result: expect.objectContaining({
        role: 'assistant',
        content: 'final-output'
      }),
      stages: expect.objectContaining({
        arcFirst: expect.objectContaining({ content: 'arc-first-output' }),
        subAgent: expect.objectContaining({ content: 'sub-agent-output' }),
        gpt5Reasoning: expect.objectContaining({ content: 'overseer-output' })
      })
    }));
  });
});
