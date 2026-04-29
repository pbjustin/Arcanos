import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runTrinityWritingPipelineMock = jest.fn();

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: runTrinityWritingPipelineMock
}));

const {
  generateReusableCodeSnippets,
  parseReusableCodeResponse,
} = await import('../src/services/reusableCodeGeneration.ts');

describe('reusable code generation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    runTrinityWritingPipelineMock.mockResolvedValue({
      result: JSON.stringify({
        snippets: [
          {
            name: 'asyncHandler',
            description: 'Async express wrapper',
            language: 'typescript',
            code: 'export const asyncHandler = () => {};',
          },
        ],
      }),
      activeModel: 'trinity-model',
      fallbackFlag: false,
      routingStages: ['TRINITY'],
      auditSafe: { mode: 'true', passed: true, flags: [] },
      taskLineage: [],
      fallbackSummary: {
        intakeFallbackUsed: false,
        gpt5FallbackUsed: false,
        finalFallbackUsed: false,
        fallbackReasons: [],
      },
      meta: {
        pipeline: 'trinity',
        bypass: false,
        sourceEndpoint: 'api.reusables',
        classification: 'writing',
      },
    });
  });

  it('parses reusable snippets through Trinity', async () => {
    const client = { responses: { create: jest.fn() } } as any;

    const result = await generateReusableCodeSnippets(
      client,
      { target: 'asyncHandler', includeDocs: true, language: 'typescript' }
    );

    expect(runTrinityWritingPipelineMock).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        moduleId: 'REUSABLE:CODE',
        sourceEndpoint: 'api.reusables',
        requestedAction: 'query',
        body: expect.objectContaining({
          target: 'asyncHandler',
          includeDocs: true,
          language: 'typescript',
        }),
      }),
      context: expect.objectContaining({
        client,
      }),
    }));
    expect(client.responses.create).not.toHaveBeenCalled();
    expect(result.model).toBe('trinity-model');
    expect(result.snippets).toEqual([
      {
        name: 'asyncHandler',
        description: 'Async express wrapper',
        language: 'typescript',
        code: 'export const asyncHandler = () => {};',
      },
    ]);
  });

  it('keeps explicit schema parsing for raw JSON helper usage', () => {
    const parsed = parseReusableCodeResponse(
      '{"snippets":[{"name":"idGenerator","description":"IDs","language":"typescript","code":"export const id=() => 1;"}]}'
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.name).toBe('idGenerator');
  });
});
