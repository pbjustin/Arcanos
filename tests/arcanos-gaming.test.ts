import { jest } from '@jest/globals';

const runGamingSpy = jest.fn();

jest.unstable_mockModule('../src/services/gaming.js', () => ({
  runGaming: runGamingSpy
}));

const { default: ArcanosGaming } = await import('../src/modules/arcanos-gaming.js');

describe('ArcanosGaming module', () => {

  beforeEach(() => {
    runGamingSpy.mockResolvedValue({ ok: true } as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('accepts message alias and single guide url', async () => {
    const payload = {
      message: 'How do I beat the boss?',
      url: ' https://example.com/guide '
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runGamingSpy).toHaveBeenCalledWith('How do I beat the boss?', 'https://example.com/guide', []);
  });

  it('normalizes additional guide collections', async () => {
    const payload = {
      prompt: 'Show me the path',
      urls: ['https://example.com/a', '  ', 42, 'https://example.com/a'],
      guideUrls: 'https://example.com/b'
    } as any;

    await ArcanosGaming.actions.query(payload);

    expect(runGamingSpy).toHaveBeenCalledWith('Show me the path', undefined, [
      'https://example.com/a',
      'https://example.com/b'
    ]);
  });

  it('rejects missing prompts', async () => {
    await expect(ArcanosGaming.actions.query({ url: 'https://example.com' } as any)).rejects.toThrow(
      'ARCANOS:GAMING query requires a text prompt.'
    );
  });
});
