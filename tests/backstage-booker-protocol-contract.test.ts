import { describe, expect, it } from '@jest/globals';

import {
  ARCANOS_PROTOCOL_COMMAND_IDS,
  ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS,
  BACKSTAGE_CANON_UTC_TIMESTAMP_PATTERN_SOURCE,
  BACKSTAGE_BOOKER_ACTIONS,
  DEFAULT_BACKSTAGE_UNIVERSE_ID,
  assertValidBackstageBookerActionData,
  assertValidBackstageBookerActionPayload,
  createProtocolAjv,
  getProtocolSchemaCatalog,
  isValidBackstageCanonUtcTimestamp,
  validateBackstageBookerActionData,
  validateBackstageBookerActionPayload,
  type BackstageBookerAction,
} from '@arcanos/protocol';

const durablePersistence = {
  status: 'durable',
  durable: true,
  backend: 'postgresql',
  degraded: false,
};

const nonDurablePersistence = {
  status: 'non_durable',
  durable: false,
  backend: 'process-memory',
  degraded: true,
  reason: 'database_unavailable',
};

const failedWritePersistence = {
  ...nonDurablePersistence,
  reason: 'database_write_failed',
};

const unknownPersistence = {
  status: 'unknown',
  durable: null,
  backend: 'postgresql',
  degraded: true,
  reason: 'commit_outcome_unknown',
};

const hrc = {
  fidelity: 0.9,
  resilience: 0.8,
  verdict: 'Consistent with supplied booking context.',
};

const storylineMutationId = '11111111-1111-4111-8111-111111111111';
const canonBeatMutationId = '22222222-2222-4222-8222-222222222222';
const storylineId = '33333333-3333-4333-8333-333333333333';
const canonBeatId = '44444444-4444-4444-8444-444444444444';
const eventId = '55555555-5555-4555-8555-555555555555';
const occurredAt = '2026-08-14T20:00:00.000Z';

const storylineInput = {
  key: 'world-title-program',
  title: 'World title program',
  summary: 'The challenger earns a title match at the next event.',
  status: 'active',
  participantNames: ['Rhea Ripley', 'Bianca Belair'],
};

const storylineModel = {
  id: storylineId,
  ...storylineInput,
  version: 2,
  universeRevision: '42',
  createdAt: '2026-08-01T12:00:00.000Z',
  updatedAt: occurredAt,
  closedAt: null,
};

const canonBeatInput = {
  kind: 'title_change',
  summary: 'The challenger wins the championship in the main event.',
  occurredAt,
  participantNames: ['Rhea Ripley', 'Bianca Belair'],
  eventId,
};

const canonBeatModel = {
  id: canonBeatId,
  storylineId,
  storylineKey: storylineInput.key,
  sequence: 1,
  ...canonBeatInput,
  supersedesBeatId: null,
  universeRevision: '43',
  createdAt: '2026-08-14T20:01:00.000Z',
};

const validRequests: Record<BackstageBookerAction, unknown> = {
  bookEvent: {
    universeId: 'promotion:raw',
    event: { name: 'Monday Night Raw', matches: 6 },
  },
  updateRoster: {
    universeId: 'promotion:raw',
    wrestlers: [{ name: 'Rhea Ripley', overall: 96 }],
  },
  trackStoryline: {
    universeId: 'promotion:raw',
    beat: { summary: 'The champion rejects the challenger.' },
  },
  simulateMatch: {
    universeId: 'promotion:raw',
    match: {
      wrestler1: 'Rhea Ripley',
      wrestler2: 'Bianca Belair',
      matchType: 'Singles',
      kayfabeMode: false,
    },
    rosters: [
      { name: 'Rhea Ripley', overall: 96 },
      { name: 'Bianca Belair', overall: 95 },
    ],
    winProbModifier: 0.05,
  },
  generateBooking: {
    universeId: 'promotion:raw',
    prompt: 'Book the next four weeks of the title program.',
  },
  generateBookingWithHRC: {
    universeId: 'promotion:raw',
    prompt: 'Book the next four weeks and score the result.',
  },
  saveStoryline: {
    universeId: 'promotion:raw',
    key: 'world-title-program',
    storyline: 'The challenger earns a title match at the next event.',
  },
  upsertStoryline: {
    universeId: 'promotion:raw',
    mutationId: storylineMutationId,
    expectedVersion: 1,
    storyline: storylineInput,
  },
  appendCanonBeat: {
    universeId: 'promotion:raw',
    mutationId: canonBeatMutationId,
    storylineKey: storylineInput.key,
    expectedVersion: 2,
    beat: canonBeatInput,
    nextStatus: 'completed',
  },
};

const validResponses: Record<BackstageBookerAction, unknown> = {
  bookEvent: {
    universeId: 'promotion:raw',
    eventId: 'event-001',
    persistence: durablePersistence,
  },
  updateRoster: {
    universeId: 'promotion:raw',
    roster: [{ name: 'Rhea Ripley', overall: 96 }],
    persistence: durablePersistence,
  },
  trackStoryline: {
    universeId: 'promotion:raw',
    beats: [{ summary: 'The champion rejects the challenger.' }],
    persistence: nonDurablePersistence,
  },
  simulateMatch: {
    universeId: 'promotion:raw',
    result: {
      match: 'Rhea Ripley vs Bianca Belair (Singles)',
      winner: 'Rhea Ripley',
      loser: 'Bianca Belair',
      probability: {
        'Rhea Ripley': '0.55',
        'Bianca Belair': '0.45',
      },
      interference: null,
      rating: '4.3',
    },
    hrc,
  },
  generateBooking: 'The champion and challenger trade victories for four weeks.',
  generateBookingWithHRC: {
    universeId: 'promotion:raw',
    storyline: 'The champion and challenger trade victories for four weeks.',
    hrc,
  },
  saveStoryline: {
    universeId: 'promotion:raw',
    key: 'world-title-program',
    saved: null,
    persistence: unknownPersistence,
  },
  upsertStoryline: {
    universeId: 'promotion:raw',
    mutationId: storylineMutationId,
    applied: true,
    universeRevision: '42',
    storyline: storylineModel,
    persistence: durablePersistence,
  },
  appendCanonBeat: {
    universeId: 'promotion:raw',
    mutationId: canonBeatMutationId,
    applied: true,
    universeRevision: '43',
    storyline: {
      ...storylineModel,
      status: 'completed',
      version: 3,
      universeRevision: '43',
      closedAt: occurredAt,
    },
    beat: canonBeatModel,
    persistence: durablePersistence,
  },
};

describe('Backstage Booker protocol contract', () => {
  it('registers complete, uniquely identified action schemas outside command IDs', () => {
    const catalog = getProtocolSchemaCatalog();
    expect(Object.keys(catalog.backstageBooker.actions)).toEqual([
      ...BACKSTAGE_BOOKER_ACTIONS,
    ]);
    expect(() => createProtocolAjv()).not.toThrow();

    const schemas = [
      catalog.backstageBooker.common,
      catalog.backstageBooker.canon,
      ...Object.values(catalog.backstageBooker.actions).flatMap(
        ({ request, response }) => [request, response]
      ),
    ];
    const ids = schemas.map((schema) => schema.$id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'https://schemas.arcanos.dev/protocol/v1/backstage-booker/common.schema.json',
        'https://schemas.arcanos.dev/protocol/v1/backstage-booker/canon.schema.json',
        'https://schemas.arcanos.dev/protocol/v1/backstage-booker/generateBooking.response.schema.json',
      ])
    );

    for (const action of BACKSTAGE_BOOKER_ACTIONS) {
      expect(ARCANOS_PROTOCOL_COMMAND_IDS).not.toContain(action);
      expect(ARCANOS_PROTOCOL_IMPLEMENTED_COMMAND_IDS).not.toContain(action);
    }
  });

  it('accepts one canonical request and response for every action', () => {
    for (const action of BACKSTAGE_BOOKER_ACTIONS) {
      expect(validateBackstageBookerActionPayload(action, validRequests[action])).toEqual({
        ok: true,
        issues: [],
      });
      expect(validateBackstageBookerActionData(action, validResponses[action])).toEqual({
        ok: true,
        issues: [],
      });
    }
  });

  it('keeps universeId optional for legacy callers without mutating the payload', () => {
    const payload = { prompt: 'Book tonight\'s main event.' };
    expect(DEFAULT_BACKSTAGE_UNIVERSE_ID).toBe('legacy');
    expect(validateBackstageBookerActionPayload('generateBooking', payload).ok).toBe(true);
    expect(payload).toEqual({ prompt: 'Book tonight\'s main event.' });

    const universeDefinition = getProtocolSchemaCatalog().backstageBooker.common
      .$defs.universeId;
    expect(universeDefinition).toEqual(
      expect.objectContaining({
        default: DEFAULT_BACKSTAGE_UNIVERSE_ID,
        pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$',
      })
    );
    for (const universeId of ['', ' leading', 'space inside', 'x'.repeat(129)]) {
      expect(
        validateBackstageBookerActionPayload('generateBooking', {
          universeId,
          prompt: 'Book tonight\'s main event.',
        }).ok
      ).toBe(false);
    }
  });

  it('requires explicit universe and mutation identities for Phase Two canon writes', () => {
    for (const action of ['upsertStoryline', 'appendCanonBeat'] as const) {
      const request = validRequests[action] as Record<string, unknown>;
      const withoutUniverseId = { ...request };
      const withoutMutationId = { ...request };
      delete withoutUniverseId.universeId;
      delete withoutMutationId.mutationId;

      expect(validateBackstageBookerActionPayload(action, withoutUniverseId).ok).toBe(
        false
      );
      expect(validateBackstageBookerActionPayload(action, withoutMutationId).ok).toBe(
        false
      );
      expect(
        validateBackstageBookerActionPayload(action, {
          ...request,
          mutationId: 'not-a-uuid',
        }).ok
      ).toBe(false);
    }
  });

  it('validates closed, versioned structured-storyline inputs', () => {
    expect(
      validateBackstageBookerActionPayload('upsertStoryline', {
        universeId: 'promotion:raw',
        mutationId: storylineMutationId,
        expectedVersion: 0,
        storyline: {
          ...storylineInput,
          summary: null,
          participantNames: ['Rhea Ripley', 'rhea ripley'],
        },
      }).ok
    ).toBe(true);

    for (const invalidRequest of [
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        expectedVersion: -1,
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        expectedVersion: 2147483648,
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: { ...storylineInput, key: 'x'.repeat(241) },
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: { ...storylineInput, title: ' ' },
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: { ...storylineInput, summary: 'x'.repeat(10001) },
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: { ...storylineInput, status: 'archived' },
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: {
          ...storylineInput,
          participantNames: ['Rhea Ripley', 'Rhea Ripley'],
        },
      },
      {
        ...validRequests.upsertStoryline as Record<string, unknown>,
        storyline: { ...storylineInput, unreviewedCanon: true },
      },
    ]) {
      expect(validateBackstageBookerActionPayload('upsertStoryline', invalidRequest).ok)
        .toBe(false);
    }
  });

  it('validates closed canon beats, real UTC calendar timestamps, and bounded identities', () => {
    const catalog = getProtocolSchemaCatalog();
    expect(catalog.backstageBooker.canon.$defs.utcTimestamp.pattern).toBe(
      BACKSTAGE_CANON_UTC_TIMESTAMP_PATTERN_SOURCE
    );

    for (const validTimestamp of [
      '0001-01-01T00:00:00Z',
      '0004-02-29T00:00:00.1Z',
      '2000-02-29T12:34:56.123456789Z',
      '2024-02-29T23:59:59Z',
      '9999-12-31T23:59:59.999Z',
    ]) {
      expect(isValidBackstageCanonUtcTimestamp(validTimestamp)).toBe(true);
    }

    expect(
      validateBackstageBookerActionPayload('appendCanonBeat', {
        universeId: 'promotion:raw',
        mutationId: canonBeatMutationId,
        storylineKey: storylineInput.key,
        expectedVersion: 1,
        beat: {
          kind: 'promo',
          summary: 'A valid canon beat.',
          occurredAt: '2026-08-14T20:00:00Z',
          participantNames: [],
          supersedesBeatId: canonBeatId,
        },
      }).ok
    ).toBe(true);

    for (const beat of [
      { ...canonBeatInput, kind: 'TitleChange' },
      { ...canonBeatInput, kind: `a${'b'.repeat(64)}` },
      { ...canonBeatInput, summary: ' ' },
      { ...canonBeatInput, summary: 'x'.repeat(10001) },
      { ...canonBeatInput, occurredAt: '2026-08-14T16:00:00-04:00' },
      { ...canonBeatInput, occurredAt: '2026-13-14T20:00:00Z' },
      { ...canonBeatInput, occurredAt: '0000-01-01T00:00:00Z' },
      { ...canonBeatInput, occurredAt: '1900-02-29T20:00:00Z' },
      { ...canonBeatInput, occurredAt: '2026-02-29T20:00:00Z' },
      { ...canonBeatInput, occurredAt: '2026-04-31T20:00:00Z' },
      { ...canonBeatInput, occurredAt: '2026-12-31T23:59:60Z' },
      { ...canonBeatInput, occurredAt: '2026-12-31T23:59:59.1234567890Z' },
      { ...canonBeatInput, occurredAt: '10000-01-01T00:00:00Z' },
      { ...canonBeatInput, participantNames: ['Rhea Ripley', 'Rhea Ripley'] },
      { ...canonBeatInput, eventId: 'not-a-uuid' },
      { ...canonBeatInput, draftOnly: true },
    ]) {
      expect(
        validateBackstageBookerActionPayload('appendCanonBeat', {
          universeId: 'promotion:raw',
          mutationId: canonBeatMutationId,
          storylineKey: storylineInput.key,
          expectedVersion: 1,
          beat,
        }).ok
      ).toBe(false);
    }

    for (const invalidTimestamp of [
      '0000-01-01T00:00:00Z',
      '1900-02-29T20:00:00Z',
      '2026-02-29T20:00:00Z',
      '2026-04-31T20:00:00Z',
      '2026-12-31T23:59:59.1234567890Z',
      '10000-01-01T00:00:00Z',
    ]) {
      expect(isValidBackstageCanonUtcTimestamp(invalidTimestamp)).toBe(false);
    }

    expect(validateBackstageBookerActionData('appendCanonBeat', {
      ...validResponses.appendCanonBeat as Record<string, unknown>,
      beat: {
        ...canonBeatModel,
        occurredAt: '2026-02-29T20:00:00Z',
      },
    }).ok).toBe(false);

    expect(
      validateBackstageBookerActionPayload('appendCanonBeat', {
        ...validRequests.appendCanonBeat as Record<string, unknown>,
        expectedVersion: 0,
      }).ok
    ).toBe(false);
  });

  it('rejects non-JSON values inside open event and storyline payloads', () => {
    expect(
      validateBackstageBookerActionPayload('bookEvent', {
        event: { invalid: undefined },
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionPayload('trackStoryline', {
        beat: { invalid: () => 'not JSON' },
      }).ok
    ).toBe(false);
  });

  it('applies PostgreSQL text rules without narrowing exact serialized story beats', () => {
    const invalidTextValues = [
      'embedded-' + String.fromCharCode(0) + '-value',
      'unpaired-high-' + String.fromCharCode(0xd800),
      'unpaired-low-' + String.fromCharCode(0xdc00),
    ];

    for (const invalidText of invalidTextValues) {
      expect(validateBackstageBookerActionPayload('saveStoryline', {
        key: invalidText,
        storyline: 'Valid storyline',
      }).ok).toBe(false);
      expect(validateBackstageBookerActionPayload('saveStoryline', {
        key: 'valid-key',
        storyline: invalidText,
      }).ok).toBe(false);
      expect(validateBackstageBookerActionPayload('bookEvent', {
        event: { card: [{ label: invalidText }] },
      }).ok).toBe(false);
      expect(validateBackstageBookerActionPayload('bookEvent', {
        event: { card: [{ [invalidText]: 'value' }] },
      }).ok).toBe(false);
      expect(validateBackstageBookerActionPayload('updateRoster', {
        wrestlers: [{ name: invalidText, overall: 90 }],
      }).ok).toBe(false);
      expect(validateBackstageBookerActionPayload('trackStoryline', {
        beat: { [invalidText]: invalidText },
      }).ok).toBe(true);
    }

    const maximumAstralKey = '🎬'.repeat(240);
    const maximumAstralStoryline = '🔥'.repeat(100_000);
    expect(validateBackstageBookerActionPayload('saveStoryline', {
      key: maximumAstralKey,
      storyline: maximumAstralStoryline,
    }).ok).toBe(true);
    expect(validateBackstageBookerActionPayload('saveStoryline', {
      key: `${maximumAstralKey}🎬`,
      storyline: 'Valid storyline',
    }).ok).toBe(false);
    expect(validateBackstageBookerActionPayload('saveStoryline', {
      key: 'valid-key',
      storyline: `${maximumAstralStoryline}🔥`,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionPayload('bookEvent', {
      event: { card: [{ label: 'Astral pair 🎬 remains valid.' }] },
    }).ok).toBe(true);
    expect(validateBackstageBookerActionPayload('updateRoster', {
      wrestlers: [{ name: '🤼'.repeat(120), overall: 90 }],
    }).ok).toBe(true);
    expect(validateBackstageBookerActionPayload('updateRoster', {
      wrestlers: [{ name: '🤼'.repeat(121), overall: 90 }],
    }).ok).toBe(false);
  });

  it('accepts only truthful durable, non-durable, and unknown persistence states', () => {
    for (const persistence of [
      durablePersistence,
      nonDurablePersistence,
      failedWritePersistence,
      unknownPersistence,
    ]) {
      expect(
        validateBackstageBookerActionData('bookEvent', {
          universeId: 'legacy',
          eventId: 'event-001',
          persistence,
        }).ok
      ).toBe(true);
    }

    for (const persistence of [
      { ...durablePersistence, degraded: true },
      { ...nonDurablePersistence, durable: true },
      { ...unknownPersistence, durable: false },
      { ...unknownPersistence, reason: 'database_unavailable' },
    ]) {
      expect(
        validateBackstageBookerActionData('bookEvent', {
          universeId: 'legacy',
          eventId: 'event-001',
          persistence,
        }).ok
      ).toBe(false);
    }

    expect(validateBackstageBookerActionData('saveStoryline', {
      universeId: 'legacy',
      key: 'world-title-program',
      saved: null,
      persistence: unknownPersistence,
    }).ok).toBe(true);
    expect(validateBackstageBookerActionData('saveStoryline', {
      universeId: 'legacy',
      key: 'world-title-program',
      saved: true,
      persistence: unknownPersistence,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionData('saveStoryline', {
      universeId: 'legacy',
      key: 'world-title-program',
      saved: null,
      persistence: durablePersistence,
    }).ok).toBe(false);
  });

  it('never represents accepted canon as non-durable and couples unknown fields to null', () => {
    const unknownUpsert = {
      universeId: 'promotion:raw',
      mutationId: storylineMutationId,
      applied: null,
      universeRevision: null,
      storyline: null,
      persistence: unknownPersistence,
    };
    const unknownAppend = {
      universeId: 'promotion:raw',
      mutationId: canonBeatMutationId,
      applied: null,
      universeRevision: null,
      storyline: null,
      beat: null,
      persistence: unknownPersistence,
    };

    expect(validateBackstageBookerActionData('upsertStoryline', unknownUpsert).ok)
      .toBe(true);
    expect(validateBackstageBookerActionData('appendCanonBeat', unknownAppend).ok)
      .toBe(true);

    expect(validateBackstageBookerActionData('upsertStoryline', {
      ...validResponses.upsertStoryline as Record<string, unknown>,
      persistence: nonDurablePersistence,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionData('appendCanonBeat', {
      ...validResponses.appendCanonBeat as Record<string, unknown>,
      persistence: nonDurablePersistence,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionData('upsertStoryline', {
      ...unknownUpsert,
      applied: true,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionData('appendCanonBeat', {
      ...unknownAppend,
      beat: canonBeatModel,
    }).ok).toBe(false);
    expect(validateBackstageBookerActionData('upsertStoryline', {
      ...validResponses.upsertStoryline as Record<string, unknown>,
      universeRevision: '0042',
    }).ok).toBe(false);
  });

  it('supports the deprecated raw generateBooking result and the canonical result', () => {
    expect(validateBackstageBookerActionData('generateBooking', 'Legacy result').ok).toBe(
      true
    );
    expect(
      validateBackstageBookerActionData('generateBooking', {
        universeId: 'legacy',
        storyline: 'Canonical result',
      }).ok
    ).toBe(true);
    expect(validateBackstageBookerActionData('generateBooking', '').ok).toBe(false);
    expect(
      validateBackstageBookerActionData('generateBooking', {
        storyline: 'Missing resolved universe',
      }).ok
    ).toBe(false);

    const responseSchema = getProtocolSchemaCatalog().backstageBooker.actions
      .generateBooking.response;
    expect(responseSchema.oneOf[0]).toEqual(
      expect.objectContaining({ type: 'string', deprecated: true })
    );
  });

  it('rejects unknown wrapper fields and bounded-field violations', () => {
    for (const action of BACKSTAGE_BOOKER_ACTIONS) {
      const request = validRequests[action] as Record<string, unknown>;
      expect(
        validateBackstageBookerActionPayload(action, {
          ...request,
          callerSelectedTenant: 'other',
        }).ok
      ).toBe(false);
    }

    expect(
      validateBackstageBookerActionPayload('updateRoster', {
        wrestlers: [{ name: 'Invalid rating', overall: 90.5 }],
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionPayload('updateRoster', {
        wrestlers: Array.from({ length: 101 }, (_, index) => ({
          name: `Wrestler ${index}`,
          overall: 50,
        })),
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionPayload('simulateMatch', {
        match: {
          wrestler1: 'A',
          wrestler2: 'B',
          matchType: 'Singles',
        },
        winProbModifier: 1.01,
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionPayload('generateBooking', {
        prompt: ' '.repeat(10),
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionPayload('saveStoryline', {
        key: 'x'.repeat(241),
        storyline: 'Valid storyline',
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionData('trackStoryline', {
        universeId: 'legacy',
        beats: Array.from({ length: 26 }, (_, index) => ({ index })),
        persistence: durablePersistence,
      }).ok
    ).toBe(false);
    expect(
      validateBackstageBookerActionData('generateBookingWithHRC', {
        universeId: 'legacy',
        storyline: 'Booking',
        hrc: { ...hrc, fidelity: 1.1 },
      }).ok
    ).toBe(false);
  });

  it('returns typed values from assertions and throws deterministic validation errors', () => {
    const request = validRequests.saveStoryline;
    const response = validResponses.saveStoryline;
    expect(assertValidBackstageBookerActionPayload('saveStoryline', request)).toBe(
      request
    );
    expect(assertValidBackstageBookerActionData('saveStoryline', response)).toBe(
      response
    );
    expect(() =>
      assertValidBackstageBookerActionPayload('generateBooking', { prompt: '' })
    ).toThrow('Invalid Backstage Booker request payload for generateBooking.');
    expect(() =>
      assertValidBackstageBookerActionData('saveStoryline', false)
    ).toThrow('Invalid Backstage Booker response data for saveStoryline.');

    const unregisteredAction = 'notRegistered' as BackstageBookerAction;
    expect(validateBackstageBookerActionPayload(unregisteredAction, {})).toEqual({
      ok: false,
      issues: [
        {
          instancePath: '/action',
          message: 'No Backstage Booker schema is registered for action "notRegistered".',
        },
      ],
    });
  });
});
