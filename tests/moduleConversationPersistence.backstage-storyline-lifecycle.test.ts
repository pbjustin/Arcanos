import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadMemory = jest.fn();
const mockSaveMemory = jest.fn();
const mockSaveMessage = jest.fn();

jest.unstable_mockModule('@core/db/index.js', () => ({
  loadMemory: mockLoadMemory,
  saveMemory: mockSaveMemory
}));

jest.unstable_mockModule('@services/sessionMemoryService.js', () => ({
  saveMessage: mockSaveMessage
}));

const { persistModuleConversation } = await import(
  '../src/services/moduleConversationPersistence.js'
);
const { buildBackstageStorylineByKeyMemoryKey } = await import(
  '../src/services/backstageBookerContracts.js'
);
const { TABLE_DEFINITIONS } = await import('../src/core/db/schema.js');

describe('Backstage storyline conversation persistence boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadMemory.mockResolvedValue(null);
    mockSaveMemory.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue(undefined);
  });

  it('does not let trackStoryline overwrite the versioned latest-beats snapshot', async () => {
    await persistModuleConversation({
      moduleName: 'BACKSTAGE:BOOKER',
      route: 'backstage',
      action: 'trackStoryline',
      gptId: 'backstage',
      requestPayload: { title: 'A new challenger appears' },
      responsePayload: [{ title: 'A new challenger appears' }]
    });

    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveMessage).not.toHaveBeenCalled();
    expect(mockLoadMemory).not.toHaveBeenCalled();
  });

  it('keeps named saveStoryline latest and keyed snapshots durable without expiry', async () => {
    await persistModuleConversation({
      moduleName: 'BACKSTAGE:BOOKER',
      route: 'backstage',
      action: 'saveStoryline',
      gptId: 'backstage',
      requestPayload: {
        key: 'summer-slam-main-event',
        storyline: 'The champion accepts the final challenge.'
      },
      responsePayload: true
    });

    expect(mockSaveMemory).toHaveBeenCalledTimes(2);
    expect(mockSaveMemory).toHaveBeenNthCalledWith(
      1,
      buildBackstageStorylineByKeyMemoryKey('legacy', 'summer-slam-main-event'),
      expect.objectContaining({
        universeId: 'legacy',
        key: 'summer-slam-main-event',
        storyline: 'The champion accepts the final challenge.',
        savedAt: expect.any(String)
      })
    );
    expect(mockSaveMemory).toHaveBeenNthCalledWith(
      2,
      'backstage-universe:legacy:storyline:latest',
      expect.objectContaining({
        universeId: 'legacy',
        key: 'summer-slam-main-event',
        storyline: 'The champion accepts the final challenge.',
        savedAt: expect.any(String)
      })
    );
    expect(mockSaveMemory.mock.calls.every(call => call.length === 2)).toBe(true);
  });

  it('keeps the named-storyline table free of an age-expiry contract', () => {
    const namedStorylineTable = TABLE_DEFINITIONS.find(sql =>
      sql.includes('CREATE TABLE IF NOT EXISTS backstage_storylines')
    );

    expect(namedStorylineTable).toBeDefined();
    expect(namedStorylineTable).toContain('story_key TEXT NOT NULL');
    expect(namedStorylineTable).toContain('UNIQUE (universe_id, story_key)');
    expect(namedStorylineTable).toContain('storyline TEXT NOT NULL');
    expect(namedStorylineTable).not.toMatch(/\bexpires_at\b/u);
  });
});
