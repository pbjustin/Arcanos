import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGenerateBooking = jest.fn();

jest.unstable_mockModule('@services/backstage-booker.js', () => ({
  BackstageBooker: {
    generateBooking: mockGenerateBooking
  }
}));

const {
  detectBackstageBookerIntent,
  tryExecuteBackstageBookerRouteShortcut
} = await import('../src/services/backstageBookerRouteShortcut.js');

describe('backstageBookerRouteShortcut', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGenerateBooking.mockResolvedValue('Generated booking response');
  });

  it('ignores generic rivalry prompts without wrestling-specific context', () => {
    expect(detectBackstageBookerIntent('Generate three rivalries for my fantasy novel.')).toBeNull();
  });

  it('detects explicit wrestling-booking prompts with RAW rivalries', () => {
    expect(
      detectBackstageBookerIntent('Generate three rivalries for RAW after WrestleMania using the current roster.')
    ).toEqual(
      expect.objectContaining({
        score: expect.any(Number),
        reason: expect.stringContaining('storyline_request')
      })
    );
  });

  it('executes the backstage booker for high-confidence booking prompts', async () => {
    const shortcut = await tryExecuteBackstageBookerRouteShortcut({
      prompt: 'Book a WWE Raw rivalry matrix for the next four weeks.',
      sessionId: 'raw_session'
    });

    expect(mockGenerateBooking).toHaveBeenCalledWith('Book a WWE Raw rivalry matrix for the next four weeks.');
    expect(shortcut).toEqual({
      resultText: 'Generated booking response',
      dispatcher: {
        module: 'BACKSTAGE:BOOKER',
        action: 'generateBooking',
        reason: expect.any(String)
      }
    });
  });
});
