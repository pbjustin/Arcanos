import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockCallOpenAI = jest.fn();
const mockGetGPT5Model = jest.fn();
const mockQuery = jest.fn();
const mockSaveMemory = jest.fn();
const mockGetEnv = jest.fn();
const mockGetEnvNumber = jest.fn();

jest.unstable_mockModule('@services/openai.js', () => ({
  callOpenAI: mockCallOpenAI,
  getGPT5Model: mockGetGPT5Model,
  getDefaultModel: jest.fn(() => 'gpt-4.1-mini'),
  getFallbackModel: jest.fn(() => 'gpt-4.1'),
  getComplexModel: jest.fn(() => 'gpt-4.1'),
  hasValidAPIKey: jest.fn(() => true),
  default: {
    callOpenAI: mockCallOpenAI,
    getGPT5Model: mockGetGPT5Model
  }
}));

jest.unstable_mockModule('@core/db/index.js', () => ({
  query: mockQuery,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: mockGetEnv,
  getEnvNumber: mockGetEnvNumber
}));

const { generateBooking } = await import('../src/services/backstage-booker.js');

describe('backstage-booker generateBooking', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetEnv.mockReturnValue(undefined);
    mockGetEnvNumber.mockReturnValue(512);
    mockGetGPT5Model.mockReturnValue('gpt-5.1-test');
    mockQuery.mockResolvedValue({ rows: [] });
    mockSaveMemory.mockResolvedValue(undefined);
    mockCallOpenAI.mockResolvedValue({ output: 'Rivalry matrix output' });
  });

  it('falls back to the shared GPT-5 model when USER_GPT_ID is absent', async () => {
    await expect(generateBooking('Generate three rivalries for RAW after WrestleMania.')).resolves.toBe('Rivalry matrix output');

    expect(mockCallOpenAI).toHaveBeenCalledWith(
      'gpt-5.1-test',
      expect.stringContaining('Generate three rivalries for RAW after WrestleMania.'),
      512,
      false
    );
  });

  it('short-circuits exact-literal anti-simulation prompts before OpenAI executes', async () => {
    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical run. Say exactly: backstage-check.'
      )
    ).resolves.toBe('backstage-check');

    expect(mockCallOpenAI).not.toHaveBeenCalled();
  });

  it('switches to direct-answer execution mode for anti-simulation booking prompts', async () => {
    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical booking meeting. Book a WWE Raw title-picture rivalry map for the next month.'
      )
    ).resolves.toBe('Rivalry matrix output');

    expect(mockCallOpenAI).toHaveBeenCalledWith(
      'gpt-5.1-test',
      expect.stringContaining('<<EXECUTION_MODE>>'),
      400,
      false
    );
    const dispatchedPrompt = mockCallOpenAI.mock.calls[0][1] as string;
    expect(dispatchedPrompt).not.toContain('<<PERSONA>>');
    expect(dispatchedPrompt).toContain('Return only 5 top-level numbered bullets.');
    expect(dispatchedPrompt).toContain('No sub-bullets, no production notes, no consequences section, and no meta commentary.');
    expect(dispatchedPrompt).not.toContain('Keep the response direct, non-theatrical, and free of role-play framing.');
  });

  it('removes preambles and trims direct-answer output to the requested short bullet count', async () => {
    mockCallOpenAI.mockResolvedValue({
      output: [
        'Gut read: center Punk vs. Drew immediately.',
        '',
        '---',
        '',
        '## 4-Week Raw Title-Picture Spine (5 Bullets)',
        '',
        '1. Quick gut check: with this six we lean into a chaotic multi-man scene that still keeps Punk vs. Drew at the center.',
        '2. **Week 2 - Crown the contender**',
        '   - Gunther wins the eliminator.',
        '3. **Week 3 - Punk and Drew implode**',
        '   - Seth stirs the chaos.',
        '4. **Week 4 - Gunther steps in**',
        '   - Contract signing turns physical.',
        '5. **PLE go-home hook**',
        '   - End with a three-way stare down.',
        '6. **Overflow**',
        '   - This should be removed.'
      ].join('\n')
    });

    await expect(
      generateBooking(
        'Answer directly. Do not simulate, role-play, or describe a hypothetical booking meeting. Book a WWE Raw title-picture rivalry for the next four weeks in five short bullets.'
      )
    ).resolves.toBe(
      [
        '1. with this six we lean into a chaotic multi-man scene that still keeps Punk vs. Drew at the center.',
        '2. Week 2 - Crown the contender',
        '3. Week 3 - Punk and Drew implode',
        '4. Week 4 - Gunther steps in',
        '5. PLE go-home hook'
      ].join('\n')
    );

    const dispatchedPrompt = mockCallOpenAI.mock.calls[0][1] as string;
    expect(dispatchedPrompt).toContain('Return only 5 top-level numbered bullets.');
    expect(dispatchedPrompt).toContain('No preamble, headings, divider lines, or conclusion.');
    expect(dispatchedPrompt).toContain('Each bullet must be one compact sentence.');
    expect(mockCallOpenAI).toHaveBeenCalledWith(
      'gpt-5.1-test',
      expect.any(String),
      240,
      false
    );
  });
});
