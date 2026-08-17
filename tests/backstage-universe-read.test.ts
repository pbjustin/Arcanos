import { describe, expect, it, jest } from '@jest/globals';

import {
  BackstageBookerRepositoryUnavailableError,
  type BackstageCanonStorylineSummaryRecord,
  type BackstageContext,
} from '../src/core/db/repositories/backstageBookerRepository.js';
import {
  BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS,
  BackstageStorylineSummaryReadRequestError,
  BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS,
  BACKSTAGE_UNIVERSE_READ_RESULT_LIMIT_BYTES,
  readBackstageStorylineSummary,
  readBackstageUniverse,
} from '../src/services/backstageUniverseRead.js';

const UNIVERSE_ID = 'my-universe-2k26';
const STORYLINE_ID = '11111111-1111-4111-8111-111111111111';
const BEAT_ID = '22222222-2222-4222-8222-222222222222';

function canonStorylineSummaryRecord(
  summary: string | null,
  storyKey = 'raw/day one?100% + 🎤'
): BackstageCanonStorylineSummaryRecord {
  return {
    id: STORYLINE_ID,
    universeId: UNIVERSE_ID,
    storyKey,
    title: 'Monday Night Raw Day One',
    summary,
    status: 'active',
    version: 5,
    createdRevision: '1',
    updatedRevision: '6',
    createdAt: new Date('2026-08-16T20:30:00.000Z'),
    updatedAt: new Date('2026-08-16T21:30:00.000Z'),
    closedAt: null,
  };
}

function emptyContext(): BackstageContext {
  return {
    roster: [],
    events: [],
    storyBeats: [],
    storylines: [],
    canonContext: {
      universeId: UNIVERSE_ID,
      revision: '0',
      storylines: [],
      activeBeats: [],
    },
  };
}

function populatedContext(): BackstageContext {
  return {
    roster: [
      {
        name: 'Becky Lynch',
        overall: 94,
        updatedAt: new Date('2026-08-16T20:00:00.000Z'),
      },
    ],
    events: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        universeId: UNIVERSE_ID,
        data: {
          name: 'Raw',
          summary: 'Punk closes the promo segment.',
          internal: { arbitrary: true },
        },
        createdAt: new Date('2026-08-16T21:00:00.000Z'),
      },
    ],
    storyBeats: [],
    storylines: [
      {
        id: '44444444-4444-4444-8444-444444444444',
        universeId: UNIVERSE_ID,
        storyKey: 'raw-main-event',
        storyline: 'Becky Lynch and Lyra Valkyria are set for the main event.',
        createdAt: new Date('2026-08-16T21:10:00.000Z'),
        updatedAt: new Date('2026-08-16T21:11:00.000Z'),
      },
    ],
    canonContext: {
      universeId: UNIVERSE_ID,
      revision: '6',
      storylines: [
        {
          id: STORYLINE_ID,
          universeId: UNIVERSE_ID,
          storyKey: 'punk-world-title',
          title: 'CM Punk World Title Program',
          summary: 'Punk has completed his show-closing promo.',
          status: 'active',
          version: 5,
          participantNames: ['CM Punk'],
          createdRevision: '1',
          updatedRevision: '6',
          createdAt: new Date('2026-08-16T20:30:00.000Z'),
          updatedAt: new Date('2026-08-16T21:30:00.000Z'),
          closedAt: null,
        },
      ],
      activeBeats: [
        {
          id: BEAT_ID,
          universeId: UNIVERSE_ID,
          storylineId: STORYLINE_ID,
          storyKey: 'punk-world-title',
          sequence: 1,
          kind: 'promo',
          summary: 'Punk states his terms.',
          occurredAt: new Date('2026-08-16T21:25:00.000Z'),
          participantNames: ['CM Punk'],
          eventId: null,
          supersedesBeatId: null,
          revision: '6',
          createdAt: new Date('2026-08-16T21:30:00.000Z'),
        },
      ],
    },
  };
}

describe('Backstage universe read projection', () => {
  it('returns a typed exact-ID PostgreSQL snapshot without raw legacy JSON', async () => {
    const context = populatedContext();
    const loadContext = jest.fn(async () => context);

    const result = await readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext },
    });

    expect(loadContext).toHaveBeenCalledTimes(1);
    expect(loadContext).toHaveBeenCalledWith(UNIVERSE_ID, {
      statementTimeoutMs: BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS,
      universeReadProjection: true,
    });
    expect(result).toMatchObject({
      universeId: UNIVERSE_ID,
      source: 'postgresql',
      hasPersistedData: true,
      truncation: {
        truncated: false,
      },
      snapshot: {
        roster: [{ name: 'Becky Lynch', overall: 94 }],
        recentEvents: [
          {
            label: 'Raw',
            summary: 'Punk closes the promo segment.',
            createdAt: '2026-08-16T21:00:00.000Z',
          },
        ],
        savedStorylines: [
          {
            key: 'raw-main-event',
            storylineExcerpt:
              'Becky Lynch and Lyra Valkyria are set for the main event.',
          },
        ],
        canon: {
          revision: '6',
          storylines: [
            {
              id: STORYLINE_ID,
              key: 'punk-world-title',
              universeRevision: '6',
              updatedAt: '2026-08-16T21:30:00.000Z',
            },
          ],
          activeBeats: [
            {
              id: BEAT_ID,
              storylineKey: 'punk-world-title',
              universeRevision: '6',
              occurredAt: '2026-08-16T21:25:00.000Z',
            },
          ],
        },
      },
    });
    expect(result.snapshot.recentEvents[0]).not.toHaveProperty('data');
  });

  it('returns an explicit empty snapshot when no stored rows are observed', async () => {
    const loadContext = jest.fn(async () => emptyContext());

    const result = await readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext },
    });

    expect(result.hasPersistedData).toBe(false);
    expect(result.snapshot).toEqual({
      roster: [],
      recentEvents: [],
      recentStoryBeats: [],
      savedStorylines: [],
      canon: {
        revision: '0',
        storylines: [],
        activeBeats: [],
      },
    });
  });

  it('rejects invalid or mixed universe identities without normalizing them', async () => {
    const loadContext = jest.fn(async () => emptyContext());
    await expect(readBackstageUniverse(` ${UNIVERSE_ID}`, {
      reader: { loadContext },
    })).rejects.toThrow('universeId must be a valid Backstage universe identifier.');
    expect(loadContext).not.toHaveBeenCalled();

    const mixed = populatedContext();
    mixed.canonContext.storylines[0]!.universeId = 'another-universe';
    await expect(readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext: async () => mixed },
    })).rejects.toThrow('mixed universe data');

    const invalidKind = populatedContext();
    invalidKind.canonContext.activeBeats[0]!.kind = 'Promo Segment';
    await expect(readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext: async () => invalidKind },
    })).rejects.toThrow('canon beat kind is invalid');
  });

  it('preserves repository-unavailable failures instead of returning an empty fallback', async () => {
    const unavailable = new BackstageBookerRepositoryUnavailableError(
      'loadContext',
      new Error('test-only database outage')
    );

    await expect(readBackstageUniverse(UNIVERSE_ID, {
      reader: {
        loadContext: async () => Promise.reject(unavailable),
      },
    })).rejects.toBe(unavailable);
  });

  it('bounds long canon state and reports every omitted collection', async () => {
    const context = emptyContext();
    context.canonContext.revision = '99';
    context.canonContext.storylines = Array.from({ length: 12 }, (_, index) => ({
      id: `${String(index + 1).padStart(8, '0')}-1111-4111-8111-111111111111`,
      universeId: UNIVERSE_ID,
      storyKey: `story-${index}`,
      title: `Story ${index}`,
      summary: '🤼'.repeat(2_000),
      status: 'active' as const,
      version: 1,
      participantNames: Array.from({ length: 15 }, (_, participantIndex) => (
        `Participant ${participantIndex}`
      )),
      createdRevision: '1',
      updatedRevision: '99',
      createdAt: new Date('2026-08-16T20:00:00.000Z'),
      updatedAt: new Date('2026-08-16T21:00:00.000Z'),
      closedAt: null,
    }));
    context.canonContext.activeBeats = Array.from({ length: 16 }, (_, index) => ({
      id: `${String(index + 101).padStart(8, '0')}-2222-4222-8222-222222222222`,
      universeId: UNIVERSE_ID,
      storylineId: context.canonContext.storylines[0]!.id,
      storyKey: 'story-0',
      sequence: index + 1,
      kind: 'development',
      summary: '🎤'.repeat(2_000),
      occurredAt: new Date(`2026-08-16T21:${String(index).padStart(2, '0')}:00.000Z`),
      participantNames: Array.from({ length: 15 }, (_, participantIndex) => (
        `Participant ${participantIndex}`
      )),
      eventId: null,
      supersedesBeatId: null,
      revision: '99',
      createdAt: new Date('2026-08-16T22:00:00.000Z'),
    }));

    const result = await readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext: async () => context },
    });

    expect(result.truncation.truncated).toBe(true);
    expect(result.snapshot.canon.storylines.length).toBeLessThanOrEqual(8);
    expect(result.snapshot.canon.activeBeats.length).toBeLessThanOrEqual(12);
    expect(result.truncation.omittedItems.canonStorylines).toBeGreaterThan(0);
    expect(result.truncation.omittedItems.activeCanonBeats).toBeGreaterThan(0);
    expect(result.truncation.omittedItems.participantNames).toBeGreaterThan(0);
    expect(Buffer.byteLength(JSON.stringify(result), 'utf8'))
      .toBeLessThanOrEqual(BACKSTAGE_UNIVERSE_READ_RESULT_LIMIT_BYTES);
  });

  it('bounds legacy identity fields before returning an OpenAPI-typed response', async () => {
    const context = populatedContext();
    context.roster[0]!.name = `${' '.repeat(120)}${'N'.repeat(121)}`;
    context.storylines[0]!.storyKey = `${' '.repeat(240)}${'k'.repeat(241)}`;
    context.storylines[0]!.storyline = 's'.repeat(1_501);

    const result = await readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext: async () => context },
    });

    expect(Array.from(result.snapshot.roster[0]!.name)).toHaveLength(120);
    expect(result.snapshot.roster[0]!.name).toBe('N'.repeat(120));
    expect(Array.from(result.snapshot.savedStorylines[0]!.key)).toHaveLength(240);
    expect(result.snapshot.savedStorylines[0]!.key).toBe('k'.repeat(240));
    expect(Array.from(result.snapshot.savedStorylines[0]!.storylineExcerpt))
      .toHaveLength(1_500);
    expect(result.truncation.sections).toEqual(expect.arrayContaining([
      'snapshot.roster.name',
      'snapshot.savedStorylines.key',
      'snapshot.savedStorylines.storylineExcerpt',
    ]));
  });

  it('normalizes leading whitespace before bounding a saved-storyline excerpt', async () => {
    const context = populatedContext();
    const leadingWhitespace = (
      ' \t\n\v\f\r\u00A0\u1680\u2000\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF'
    ).repeat(100);
    context.storylines[0]!.storyline = `${leadingWhitespace}${'N'.repeat(1_501)}`;

    const result = await readBackstageUniverse(UNIVERSE_ID, {
      reader: { loadContext: async () => context },
    });

    expect(result.snapshot.savedStorylines[0]!.storylineExcerpt)
      .toBe('N'.repeat(1_500));
    expect(result.truncation.sections).toContain(
      'snapshot.savedStorylines.storylineExcerpt'
    );
  });
});

describe('Backstage exact storyline summary read', () => {
  it('reconstructs a 10,000-code-point Unicode summary in three version-fenced pages', async () => {
    const storyKey = 'raw/day one?100% + 🎤';
    const summary = Array.from(
      { length: 10_000 },
      (_value, index) => index % 2 === 0 ? '🤼' : String(index % 10)
    ).join('');
    const loadCanonStorylineSummary = jest.fn(async () =>
      canonStorylineSummaryRecord(summary, storyKey)
    );
    const reader = { loadCanonStorylineSummary };

    const first = await readBackstageStorylineSummary(
      UNIVERSE_ID,
      storyKey,
      { reader }
    );
    const second = await readBackstageStorylineSummary(
      UNIVERSE_ID,
      storyKey,
      { reader, offset: first.summaryPage.nextOffset!, expectedVersion: 5 }
    );
    const third = await readBackstageStorylineSummary(
      UNIVERSE_ID,
      storyKey,
      { reader, offset: second.summaryPage.nextOffset!, expectedVersion: 5 }
    );

    expect(loadCanonStorylineSummary).toHaveBeenCalledTimes(3);
    expect(loadCanonStorylineSummary).toHaveBeenNthCalledWith(
      1,
      UNIVERSE_ID,
      storyKey,
      { statementTimeoutMs: BACKSTAGE_UNIVERSE_READ_DB_STATEMENT_TIMEOUT_MS }
    );
    expect(first).toMatchObject({
      universeId: UNIVERSE_ID,
      source: 'postgresql',
      pageCodePointLimit: BACKSTAGE_STORYLINE_SUMMARY_PAGE_CODE_POINTS,
      storyline: {
        id: STORYLINE_ID,
        key: storyKey,
        version: 5,
        universeRevision: '6',
      },
      summaryPage: {
        startCodePoint: 0,
        endCodePointExclusive: 4_000,
        totalCodePoints: 10_000,
        hasMore: true,
        nextOffset: 4_000,
      },
    });
    expect(second.summaryPage).toMatchObject({
      startCodePoint: 4_000,
      endCodePointExclusive: 8_000,
      hasMore: true,
      nextOffset: 8_000,
    });
    expect(third.summaryPage).toMatchObject({
      startCodePoint: 8_000,
      endCodePointExclusive: 10_000,
      hasMore: false,
      nextOffset: null,
    });
    expect([
      first.summaryPage.text,
      second.summaryPage.text,
      third.summaryPage.text,
    ].join('')).toBe(summary);
    expect(Array.from(first.summaryPage.text!)).toHaveLength(4_000);
    expect(Array.from(second.summaryPage.text!)).toHaveLength(4_000);
    expect(Array.from(third.summaryPage.text!)).toHaveLength(2_000);
  });

  it('rejects a noncanonical key with outer whitespace before repository access', async () => {
    const loadCanonStorylineSummary = jest.fn();

    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      '  raw/day one?100% + 🎤  ',
      { reader: { loadCanonStorylineSummary } }
    )).rejects.toBeInstanceOf(BackstageStorylineSummaryReadRequestError);
    expect(loadCanonStorylineSummary).not.toHaveBeenCalled();
  });

  it('requires a version fence after page zero and rejects offsets beyond the summary', async () => {
    const loadCanonStorylineSummary = jest.fn(async () =>
      canonStorylineSummaryRecord('short summary', 'short-story')
    );
    const reader = { loadCanonStorylineSummary };

    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      'short-story',
      { reader, offset: 1 }
    )).rejects.toBeInstanceOf(BackstageStorylineSummaryReadRequestError);
    expect(loadCanonStorylineSummary).not.toHaveBeenCalled();

    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      'short-story',
      { reader, offset: 14, expectedVersion: 5 }
    )).rejects.toBeInstanceOf(BackstageStorylineSummaryReadRequestError);
    expect(loadCanonStorylineSummary).toHaveBeenCalledTimes(1);
  });

  it('returns a version conflict before exposing a continuation from changed canon', async () => {
    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      'raw-day-one-baseline',
      {
        reader: {
          loadCanonStorylineSummary: async () =>
            canonStorylineSummaryRecord('changed', 'raw-day-one-baseline'),
        },
        offset: 1,
        expectedVersion: 4,
      }
    )).rejects.toMatchObject({
      code: 'BACKSTAGE_STORYLINE_VERSION_CONFLICT',
    });
  });

  it('preserves null and empty summaries as distinct values', async () => {
    const nullResult = await readBackstageStorylineSummary(
      UNIVERSE_ID,
      'null-summary',
      {
        reader: {
          loadCanonStorylineSummary: async () =>
            canonStorylineSummaryRecord(null, 'null-summary'),
        },
      }
    );
    const emptyResult = await readBackstageStorylineSummary(
      UNIVERSE_ID,
      'empty-summary',
      {
        reader: {
          loadCanonStorylineSummary: async () =>
            canonStorylineSummaryRecord('', 'empty-summary'),
        },
      }
    );

    expect(nullResult.summaryPage).toEqual({
      text: null,
      startCodePoint: 0,
      endCodePointExclusive: 0,
      totalCodePoints: 0,
      hasMore: false,
      nextOffset: null,
    });
    expect(emptyResult.summaryPage).toEqual({
      text: '',
      startCodePoint: 0,
      endCodePointExclusive: 0,
      totalCodePoints: 0,
      hasMore: false,
      nextOffset: null,
    });
  });

  it('preserves not-found and repository-unavailable failures without fallback', async () => {
    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      'missing-story',
      {
        reader: { loadCanonStorylineSummary: async () => null },
      }
    )).rejects.toMatchObject({ code: 'BACKSTAGE_STORYLINE_NOT_FOUND' });

    const unavailable = new BackstageBookerRepositoryUnavailableError(
      'loadCanonStorylineSummary',
      new Error('test-only database outage')
    );
    await expect(readBackstageStorylineSummary(
      UNIVERSE_ID,
      'raw-day-one-baseline',
      {
        reader: {
          loadCanonStorylineSummary: async () => Promise.reject(unavailable),
        },
      }
    )).rejects.toBe(unavailable);
  });
});
