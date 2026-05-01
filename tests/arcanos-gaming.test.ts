import { jest } from '@jest/globals';

const runGuidePipelineSpy = jest.fn();
const runBuildPipelineSpy = jest.fn();
const runMetaPipelineSpy = jest.fn();

jest.unstable_mockModule('../src/services/gaming.js', () => ({
  runGuidePipeline: runGuidePipelineSpy,
  runBuildPipeline: runBuildPipelineSpy,
  runMetaPipeline: runMetaPipelineSpy,
}));

const { default: ArcanosGaming } = await import('../src/modules/arcanos-gaming.js');

describe('ArcanosGaming module', () => {

  beforeEach(() => {
    runGuidePipelineSpy.mockResolvedValue({ ok: true } as any);
    runBuildPipelineSpy.mockResolvedValue({ ok: true } as any);
    runMetaPipelineSpy.mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('declares query as its default non-privileged module action', () => {
    expect(ArcanosGaming.name).toBe('ARCANOS:GAMING');
    expect(ArcanosGaming.gptIds).toEqual(['arcanos-gaming', 'gaming']);
    expect(ArcanosGaming.defaultAction).toBe('query');
    expect(Object.keys(ArcanosGaming.actions)).toEqual(['query']);
  });

  it('accepts guide mode, message alias, and a single guide url', async () => {
    const payload = {
      mode: 'guide',
      message: 'How do I beat the boss?',
      url: ' https://example.com/guide '
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runGuidePipelineSpy).toHaveBeenCalledWith({
      prompt: 'How do I beat the boss?',
      game: undefined,
      guideUrl: 'https://example.com/guide',
      guideUrls: [],
      auditEnabled: false,
    });
  });

  it('normalizes guide collections for build mode', async () => {
    const payload = {
      mode: 'build',
      prompt: 'Show me the path',
      game: 'SWTOR',
      urls: ['https://example.com/a', '  ', 42, 'https://example.com/a'],
      guideUrls: 'https://example.com/b'
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runBuildPipelineSpy).toHaveBeenCalledWith({
      prompt: 'Show me the path',
      game: 'SWTOR',
      guideUrl: undefined,
      guideUrls: ['https://example.com/a', 'https://example.com/b'],
      auditEnabled: false,
    });
  });

  it('returns a structured error when mode is missing', async () => {
    await expect(ArcanosGaming.actions.query({ url: 'https://example.com' } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: null,
      error: {
        code: 'GAMEPLAY_MODE_REQUIRED',
        message: "Gameplay requests require explicit mode 'guide', 'build', or 'meta'.",
      },
    });
  });

  it('returns a structured error when build mode omits game', async () => {
    await expect(ArcanosGaming.actions.query({
      mode: 'build',
      prompt: 'Optimize my setup'
    } as any)).resolves.toEqual({
      ok: false,
      route: 'gaming',
      mode: 'build',
      error: {
        code: 'BAD_REQUEST',
        message: "Gaming mode 'build' requires a game field.",
      },
    });
  });
});
