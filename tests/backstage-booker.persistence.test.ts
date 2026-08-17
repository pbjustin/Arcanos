import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { BACKSTAGE_BOOK_EVENT_MAX_BYTES } from '../src/shared/backstage/backstageEvent.js';
import {
  BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
} from '../src/shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
} from '../src/shared/backstage/backstageStoryline.js';

const mockGetPool = jest.fn();
const mockSaveMemory = jest.fn();
const mockSaveWithAuditCheck = jest.fn();
const mockEvaluateWithHRC = jest.fn();
const mockCreateBackstageBookerRepository = jest.fn();
const mockRunTrinityWritingPipeline = jest.fn();
const mockGetOpenAIClientOrAdapter = jest.fn();

const mockRepository = {
  appendCanonBeat: jest.fn(),
  bookEvent: jest.fn(),
  updateRoster: jest.fn(),
  trackStoryline: jest.fn(),
  saveStoryline: jest.fn(),
  upsertStoryline: jest.fn(),
  loadCanonContext: jest.fn(),
  loadContext: jest.fn(),
  loadRoster: jest.fn()
};

class MockBackstageBookerRepositoryUnavailableError extends Error {
  readonly operation: string;
  readonly cause: unknown;

  constructor(operation: string, cause?: unknown) {
    super('Backstage Booker persistence is unavailable.');
    this.name = 'BackstageBookerRepositoryUnavailableError';
    this.operation = operation;
    this.cause = cause;
  }
}

class MockBackstageBookerWriteError extends Error {
  readonly operation: string;
  readonly cause: unknown;
  readonly rollbackCause: unknown;

  constructor(operation: string, cause: unknown, rollbackCause?: unknown) {
    super('Backstage Booker persistence failed before commit.');
    this.name = 'BackstageBookerWriteError';
    this.operation = operation;
    this.cause = cause;
    this.rollbackCause = rollbackCause;
  }
}

class MockBackstageBookerCommitUnknownError extends Error {
  readonly operation: string;
  readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super('Backstage Booker commit outcome is unknown.');
    this.name = 'BackstageBookerCommitUnknownError';
    this.operation = operation;
    this.cause = cause;
  }
}

class MockBackstageBookerUniverseScopeNotActivatedError extends Error {
  readonly code = 'BACKSTAGE_BOOKER_UNIVERSE_SCOPE_NOT_ACTIVATED';

  constructor() {
    super('Backstage Booker universe-scoped persistence is not activated.');
    this.name = 'BackstageBookerUniverseScopeNotActivatedError';
  }
}

jest.unstable_mockModule('@core/db/index.js', () => ({
  AUDITED_TRANSIENT_READ_QUERIES: {},
  applyBackstageRosterMutation: jest.fn(),
  applyBackstageStorylineMutation: jest.fn(),
  getPool: mockGetPool,
  isTransactionCommitAmbiguousError: jest.fn(() => false),
  query: jest.fn(),
  saveMemory: mockSaveMemory,
  transaction: jest.fn()
}));

jest.unstable_mockModule('@core/db/repositories/backstageBookerRepository.js', () => ({
  BackstageBookerCommitUnknownError: MockBackstageBookerCommitUnknownError,
  BackstageBookerRepositoryUnavailableError: MockBackstageBookerRepositoryUnavailableError,
  BackstageBookerUniverseScopeNotActivatedError:
    MockBackstageBookerUniverseScopeNotActivatedError,
  BackstageBookerWriteError: MockBackstageBookerWriteError,
  createBackstageBookerRepository: mockCreateBackstageBookerRepository,
  isBackstageBookerUniverseScopeNotActivatedError: (value: unknown) => (
    value instanceof MockBackstageBookerUniverseScopeNotActivatedError
  )
}));

jest.unstable_mockModule('@services/persistenceManager.js', () => ({
  saveWithAuditCheck: mockSaveWithAuditCheck
}));

jest.unstable_mockModule('@services/hrcWrapper.js', () => ({
  evaluateWithHRC: mockEvaluateWithHRC
}));

jest.unstable_mockModule('@core/logic/trinityWritingPipeline.js', () => ({
  runTrinityWritingPipeline: mockRunTrinityWritingPipeline
}));

jest.unstable_mockModule('@services/openai.js', () => ({
  getGPT5Model: jest.fn(() => 'gpt-test')
}));

jest.unstable_mockModule('@services/openai/clientBridge.js', () => ({
  getOpenAIClientOrAdapter: mockGetOpenAIClientOrAdapter
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: jest.fn(() => undefined),
  getEnvNumber: jest.fn((_key: string, fallback: number) => fallback)
}));

const {
  BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
  BackstageBookerModule,
  appendCanonBeat,
  bookEvent,
  buildBackstageCanonRequestFingerprint,
  generateBooking,
  getBackstageBookerProcessStateStatsForTests,
  isBackstageCanonUnavailableError,
  resetBackstageBookerProcessStateForTests,
  saveStoryline,
  simulateMatch,
  trackStoryline,
  upsertStoryline,
  updateRoster
} = await import('../src/services/backstage-booker.js');
const {
  BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS,
  BACKSTAGE_FLATTENED_PAYLOAD_FLAG,
  normalizeBackstageBookerSchemaDrivenActionPayload,
} = await import('../src/services/backstageBookerContracts.js');

const durablePersistence = {
  status: 'durable',
  durable: true,
  backend: 'postgresql',
  degraded: false
};
let mockSavedStorylineRevision = 10_000;

function savedStorylineMutation(
  universeId: string,
  storyKey: string,
  storyline: string,
  revision = String(++mockSavedStorylineRevision)
) {
  const timestamp = new Date('2026-08-14T12:00:00.000Z');
  return {
    id: `saved-${revision}`,
    universeId,
    storyKey,
    storyline,
    createdAt: timestamp,
    updatedAt: timestamp,
    revision
  };
}

const canonMutationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const canonStorylineId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const canonBeatId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function canonStorylineRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: canonStorylineId,
    universeId: 'phase-two',
    storyKey: 'summer-feud',
    title: 'Summer Feud',
    summary: 'A rivalry built around the world championship.',
    status: 'active',
    version: 1,
    participantNames: ['Alex Star', 'Blake Stone'],
    createdRevision: '20001',
    updatedRevision: '20001',
    createdAt: new Date('2026-08-14T15:00:00.000Z'),
    updatedAt: new Date('2026-08-14T15:00:00.000Z'),
    closedAt: null,
    ...overrides
  };
}

function canonBeatRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: canonBeatId,
    universeId: 'phase-two',
    storylineId: canonStorylineId,
    storyKey: 'summer-feud',
    sequence: 1,
    kind: 'development',
    summary: 'Alex interrupts Blake after the main event.',
    occurredAt: new Date('2026-08-15T02:00:00.000Z'),
    participantNames: ['Alex Star', 'Blake Stone'],
    eventId: null,
    supersedesBeatId: null,
    revision: '20002',
    createdAt: new Date('2026-08-15T02:01:00.000Z'),
    ...overrides
  };
}

function emptyCanonContext(universeId: string) {
  return {
    universeId,
    revision: '0',
    storylines: [],
    activeBeats: []
  };
}

describe('Backstage Booker service persistence outcomes', () => {
  beforeEach(() => {
    resetBackstageBookerProcessStateForTests();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockGetPool.mockReset();
    mockSaveMemory.mockReset();
    mockSaveWithAuditCheck.mockReset();
    mockEvaluateWithHRC.mockReset();
    mockCreateBackstageBookerRepository.mockReset();
    mockRunTrinityWritingPipeline.mockReset();
    mockGetOpenAIClientOrAdapter.mockReset();
    for (const method of Object.values(mockRepository)) {
      method.mockReset();
    }

    mockGetPool.mockReturnValue({ kind: 'test-pool' });
    mockCreateBackstageBookerRepository.mockReturnValue(mockRepository);
    mockSaveMemory.mockResolvedValue(undefined);
    mockSaveWithAuditCheck.mockResolvedValue(true);
    mockEvaluateWithHRC.mockResolvedValue({
      fidelity: 1,
      resilience: 1,
      verdict: 'PASS'
    });
    mockRepository.bookEvent.mockResolvedValue(undefined);
    mockRepository.updateRoster.mockResolvedValue([]);
    mockRepository.trackStoryline.mockResolvedValue([]);
    mockSavedStorylineRevision = 10_000;
    mockRepository.saveStoryline.mockImplementation(
      async (universeId: string, storyKey: string, storyline: string) => (
        savedStorylineMutation(universeId, storyKey, storyline)
      )
    );
    mockRepository.loadContext.mockImplementation(async (universeId: string) => ({
      roster: [],
      events: [],
      storyBeats: [],
      storylines: [],
      canonContext: emptyCanonContext(universeId)
    }));
    mockRepository.loadCanonContext.mockRejectedValue(new Error('canon context unavailable'));
    mockRepository.loadRoster.mockResolvedValue([]);
    mockGetOpenAIClientOrAdapter.mockReturnValue({ client: { responses: {} } });
    mockRunTrinityWritingPipeline.mockResolvedValue({
      result: 'Generated booking',
      activeModel: 'gpt-test',
      fallbackFlag: false,
      routingStages: ['TRINITY'],
      auditSafe: { mode: 'true', passed: true, flags: [] },
      taskLineage: [],
      fallbackSummary: {
        fallbackUsed: false,
        fallbackCount: 0,
        finalFallbackStage: null,
        fallbackReasons: []
      }
    });
  });

  it('reports a successful transactional event write as durable', async () => {
    const event = { name: 'SummerSlam', city: 'Nashville' };

    const result = await bookEvent(event, 'durable-universe');

    expect(result).toEqual({
      universeId: 'durable-universe',
      eventId: expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      ),
      persistence: durablePersistence
    });
    expect(mockCreateBackstageBookerRepository).toHaveBeenCalledTimes(1);
    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      'durable-universe',
      event,
      result.eventId
    );
  });

  it('bounds the HRC follow-up after a generated booking', async () => {
    mockRunTrinityWritingPipeline.mockResolvedValueOnce({
      result: [
        'Quick gut check: this preamble must be removed.',
        '1. The overall verdict is positive. Punk supplies the through-line. This sentence is extra.',
        '2. The results establish a clear hierarchy. The ratings support it.',
        '3. The promos advance the central conflict. The segments add connective tissue.',
        '4. The rivalries remain coherent. One transition needs motivation.',
        '5. The pacing builds steadily. Move one recap earlier.',
        '6. Becky vs. Lyra remains unresolved. Let the match determine the next branch.',
        '7. This overflow bullet must be removed.'
      ].join('\n')
    });
    const expectedStoryline = [
      '1. The overall verdict is positive. Punk supplies the through-line.',
      '2. The results establish a clear hierarchy. The ratings support it.',
      '3. The promos advance the central conflict. The segments add connective tissue.',
      '4. The rivalries remain coherent. One transition needs motivation.',
      '5. The pacing builds steadily. Move one recap earlier.',
      '6. Becky vs. Lyra remains unresolved. Let the match determine the next branch.'
    ].join('\n');
    const result = await BackstageBookerModule.actions.generateBookingWithHRC({
      universeId: 'hrc-timeout-universe',
      prompt: 'Review the complete Raw card.'
    });

    expect(result).toEqual({
      universeId: 'hrc-timeout-universe',
      storyline: expectedStoryline,
      hrc: {
        fidelity: 1,
        resilience: 1,
        verdict: 'PASS'
      }
    });
    expect(mockRunTrinityWritingPipeline).toHaveBeenCalledWith(expect.objectContaining({
      input: expect.objectContaining({
        tokenLimit: 1_600,
        body: expect.objectContaining({ tokenLimit: 1_600 })
      }),
      context: expect.objectContaining({
        runOptions: expect.objectContaining({
          answerMode: 'direct',
          internalMode: false,
          directAnswerTokenLimitOverride: 1_600,
          directAnswerTokenCapOverride: 2_400
        })
      })
    }));
    expect(mockEvaluateWithHRC).toHaveBeenCalledWith(expectedStoryline, {
      timeoutMs: 10_000
    });
    expect(mockRunTrinityWritingPipeline.mock.invocationCallOrder[0]).toBeLessThan(
      mockEvaluateWithHRC.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY
    );
  });

  it('does not start HRC when bounded review generation fails', async () => {
    mockRunTrinityWritingPipeline.mockRejectedValueOnce(new Error('provider output incomplete'));
    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      BackstageBookerModule.actions.generateBookingWithHRC({
        universeId: 'hrc-generation-failure-universe',
        prompt: 'Assess the complete Raw card.'
      })
    ).rejects.toThrow('Booking generation failed');

    expect(mockEvaluateWithHRC).not.toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('preserves a raw top-level event field through the module action adapter', async () => {
    const event = {
      event: 'WrestleMania',
      venue: 'MSG',
      action: 'announce-card',
      context: { brand: 'Raw' },
      mode: 'canon',
      hrc: { requested: true },
      content: 'Night-one main event'
    };

    await BackstageBookerModule.actions.bookEvent(event);

    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      'legacy',
      event,
      expect.any(String)
    );
  });

  it('passes a valid event larger than the storyline beat limit through the module adapter', async () => {
    const event = {
      name: 'Two-night stadium event',
      productionNotes: 'x'.repeat(20 * 1024)
    };

    expect(Buffer.byteLength(JSON.stringify(event), 'utf8'))
      .toBeGreaterThan(BACKSTAGE_STORYLINE_MAX_BYTES);
    await BackstageBookerModule.actions.bookEvent(event);

    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      'legacy',
      event,
      expect.any(String)
    );
  });

  it('accepts an event exactly at the serialized UTF-8 byte ceiling', async () => {
    const emptyEventBytes = Buffer.byteLength(JSON.stringify({ payload: '' }), 'utf8');
    const event = {
      payload: 'x'.repeat(BACKSTAGE_BOOK_EVENT_MAX_BYTES - emptyEventBytes)
    };
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8'))
      .toBe(BACKSTAGE_BOOK_EVENT_MAX_BYTES);

    await expect(bookEvent(event, 'maximum-event')).resolves.toMatchObject({
      universeId: 'maximum-event',
      persistence: durablePersistence
    });
    expect(mockRepository.bookEvent).toHaveBeenCalledTimes(1);
    expect(getBackstageBookerProcessStateStatsForTests('maximum-event')).toMatchObject({
      retainedEventCount: 1,
      retainedEventBytes: BACKSTAGE_BOOK_EVENT_MAX_BYTES
    });
  });

  it('rejects an event one serialized UTF-8 byte over before durable or fallback effects', async () => {
    const emptyEventBytes = Buffer.byteLength(JSON.stringify({ payload: '' }), 'utf8');
    const event = {
      payload: 'x'.repeat(BACKSTAGE_BOOK_EVENT_MAX_BYTES - emptyEventBytes + 1)
    };
    expect(Buffer.byteLength(JSON.stringify(event), 'utf8'))
      .toBe(BACKSTAGE_BOOK_EVENT_MAX_BYTES + 1);

    for (const configuredPool of [{ kind: 'test-pool' }, null]) {
      mockGetPool.mockReturnValue(configuredPool);
      await expect(bookEvent(event, 'oversized-event')).rejects.toMatchObject({
        name: 'BackstageBookerContractError',
        action: 'bookEvent',
        issues: [expect.objectContaining({
          instancePath: '/event',
          message: expect.stringContaining(String(BACKSTAGE_BOOK_EVENT_MAX_BYTES))
        })]
      });
    }

    expect(mockGetPool).not.toHaveBeenCalled();
    expect(mockCreateBackstageBookerRepository).not.toHaveBeenCalled();
    expect(mockRepository.bookEvent).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
    expect(getBackstageBookerProcessStateStatsForTests('oversized-event')).toMatchObject({
      universeCount: 0,
      retainedEventCount: 0,
      retainedEventBytes: 0
    });
  });

  it('retains the pre-write event snapshot when the caller mutates its input in flight', async () => {
    const universeId = 'immutable-event-snapshot';
    const event: {
      name: string;
      card: { mainEvent: string; cycle?: unknown };
    } = {
      name: 'Original Event Name',
      card: { mainEvent: 'Original Main Event' }
    };
    let releaseWrite!: () => void;
    mockRepository.bookEvent.mockImplementationOnce(async () => (
      new Promise<void>(resolve => {
        releaseWrite = resolve;
      })
    ));

    const write = bookEvent(event, universeId);
    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      universeId,
      {
        name: 'Original Event Name',
        card: { mainEvent: 'Original Main Event' }
      },
      expect.any(String)
    );
    expect(mockRepository.bookEvent.mock.calls[0]?.[1]).not.toBe(event);

    event.name = 'Mutated Event Name';
    event.card.mainEvent = 'Mutated Main Event';
    event.card.cycle = event;
    releaseWrite();
    await expect(write).resolves.toMatchObject({
      universeId,
      persistence: durablePersistence
    });
    const retainedBytes = getBackstageBookerProcessStateStatsForTests(universeId)
      .retainedEventBytes;
    expect(getBackstageBookerProcessStateStatsForTests(universeId).retainedEventBytes)
      .toBe(retainedBytes);

    mockRepository.loadContext.mockRejectedValueOnce(new Error('context unavailable'));
    await generateBooking('Book from the immutable event.', universeId);
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).toContain('Original Event Name');
    expect(pipelineInput?.input?.prompt).toContain('Original Main Event');
    expect(pipelineInput?.input?.prompt).not.toContain('Mutated Event Name');
    expect(pipelineInput?.input?.prompt).not.toContain('Mutated Main Event');
  });

  it('bounds combined durable and pending event retention by count and serialized bytes', async () => {
    const universeId = 'bounded-event-retention';
    mockRepository.bookEvent.mockImplementation(async (
      _resolvedUniverseId: string,
      event: { name: string }
    ) => {
      const eventIndex = Number(event.name.slice('event-'.length));
      if (eventIndex % 2 === 1) {
        throw new MockBackstageBookerWriteError(
          'bookEvent',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        );
      }
    });

    for (let index = 0; index < 40; index += 1) {
      await bookEvent({
        name: `event-${index}`,
        productionNotes: 'x'.repeat(12 * 1024)
      }, universeId);
    }

    const stats = getBackstageBookerProcessStateStatsForTests(universeId);
    expect(stats.retainedEventCount).toBeLessThanOrEqual(25);
    expect(stats.retainedEventBytes).toBeLessThanOrEqual(256 * 1024);
    mockRepository.loadContext.mockRejectedValueOnce(new Error('context unavailable'));
    await generateBooking('Book from bounded event continuity.', universeId);
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).toContain('event-39');
    expect(pipelineInput?.input?.prompt).not.toContain('event-0');
  });

  it('preserves a raw top-level beat field through the module action adapter', async () => {
    const beat = {
      beat: 'turn',
      feud: 'A/B',
      action: 'betrayal',
      context: { target: 'champion' },
      mode: 'canon',
      hrc: { requested: true },
      content: 'The ally reveals the plan.'
    };
    mockRepository.trackStoryline.mockResolvedValueOnce({
      retainedBeats: [beat],
      revision: '500'
    });

    await BackstageBookerModule.actions.trackStoryline(beat);

    expect(mockRepository.trackStoryline).toHaveBeenCalledWith('legacy', beat);
  });

  it('preserves an exact object-valued event field as a legacy domain record', async () => {
    const event = { event: { name: 'Raw' } };

    await BackstageBookerModule.actions.bookEvent(event);

    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      'legacy',
      event,
      expect.any(String)
    );
  });

  it('preserves an exact object-valued beat field as a legacy domain record', async () => {
    const beat = { beat: { turn: 'heel' } };
    mockRepository.trackStoryline.mockResolvedValueOnce({
      retainedBeats: [beat],
      revision: '501'
    });

    await BackstageBookerModule.actions.trackStoryline(beat);

    expect(mockRepository.trackStoryline).toHaveBeenCalledWith('legacy', beat);
  });

  it('unwraps a schema-driven canonical event without an explicit universe scope', async () => {
    const event = { name: 'Canonical Raw' };
    const payload = normalizeBackstageBookerSchemaDrivenActionPayload(
      'bookEvent',
      { event }
    );

    await BackstageBookerModule.actions.bookEvent(payload);

    expect(mockRepository.bookEvent).toHaveBeenCalledWith(
      'legacy',
      event,
      expect.any(String)
    );
  });

  it('unwraps a schema-driven canonical beat without an explicit universe scope', async () => {
    const beat = { turn: 'heel' };
    mockRepository.trackStoryline.mockResolvedValueOnce({
      retainedBeats: [beat],
      revision: '502'
    });
    const payload = normalizeBackstageBookerSchemaDrivenActionPayload(
      'trackStoryline',
      { beat }
    );

    await BackstageBookerModule.actions.trackStoryline(payload);

    expect(mockRepository.trackStoryline).toHaveBeenCalledWith('legacy', beat);
  });

  it.each([
    [BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS, ['event']],
    [BACKSTAGE_FLATTENED_PAYLOAD_FLAG, true],
  ] as const)('rejects caller-forged schema provenance in %s', (reservedKey, markerValue) => {
    expect(() => normalizeBackstageBookerSchemaDrivenActionPayload('bookEvent', {
      event: { name: 'SummerSlam' },
      callerSelectedTenant: 'forbidden',
      [reservedKey]: markerValue,
    })).toThrow('Invalid Backstage Booker bookEvent payload.');
  });

  it('preserves typed roster validation failures through the module action adapter', async () => {
    await expect(
      BackstageBookerModule.actions.updateRoster({ name: 'not-an-array', overall: 90 })
    ).rejects.toMatchObject({
      name: 'BackstageRosterValidationError',
      code: BACKSTAGE_ROSTER_VALIDATION_ERROR_CODE,
      message: 'Roster payload must be an array.'
    });

    expect(mockGetPool).not.toHaveBeenCalled();
    expect(mockCreateBackstageBookerRepository).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('preserves typed storyline validation failures through the module action adapter', async () => {
    await expect(
      BackstageBookerModule.actions.trackStoryline([])
    ).rejects.toMatchObject({
      name: 'BackstageStorylineValidationError',
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE,
      message: 'Storyline beat payload must be a JSON object.'
    });

    expect(mockGetPool).not.toHaveBeenCalled();
    expect(mockCreateBackstageBookerRepository).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('retains the storyline beat byte limit through the module action adapter', async () => {
    const beat = { detail: 'x'.repeat(BACKSTAGE_STORYLINE_MAX_BYTES) };

    await expect(
      BackstageBookerModule.actions.trackStoryline(beat)
    ).rejects.toMatchObject({
      name: 'BackstageStorylineValidationError',
      code: BACKSTAGE_STORYLINE_VALIDATION_ERROR_CODE
    });

    expect(mockRepository.trackStoryline).not.toHaveBeenCalled();
  });

  it('renders authoritative repository story-beat data into generation context', async () => {
    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [],
      events: [],
      storyBeats: [{
        data: { beat: 'Contract signing confrontation' },
        createdAt: new Date('2026-08-14T12:00:00.000Z')
      }],
      storylines: [],
      canonContext: emptyCanonContext('serialized-context')
    });

    await expect(generateBooking('Book the next chapter.', 'serialized-context'))
      .resolves.toBe('Generated booking');

    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls[0]?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).toContain('Contract signing confrontation');
    expect(pipelineInput?.input?.prompt).not.toContain('<<RECENT_STORY_BEATS>>\n- 2026-08-14T12:00:00.000Z :: {}');
    expect(pipelineInput?.input?.prompt).not.toContain('<<CANON_STORYLINES>>');
    expect(pipelineInput?.input?.prompt).not.toContain('<<CANON_BEATS>>');
    expect(mockRepository.loadCanonContext).not.toHaveBeenCalled();
  });

  it('overlays accepted non-durable continuity onto successful repository context reads', async () => {
    const universeId = 'preactivation-generation';
    const durableEvent = { marker: 'Durable-only-marker' };
    const durableWrite = await bookEvent(durableEvent, universeId);

    mockRepository.bookEvent.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'bookEvent',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    mockRepository.updateRoster.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'updateRoster',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    mockRepository.trackStoryline.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'trackStoryline',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    mockRepository.saveStoryline.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'saveStoryline',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );

    await bookEvent({ name: 'Pending Collision' }, universeId);
    await updateRoster([{ name: 'Pending Wrestler', overall: 93 }], universeId);
    await trackStoryline({ beat: 'Pending betrayal' }, universeId);
    await saveStoryline('pending-story', 'Pending championship arc.', universeId);

    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [],
      events: [{
        id: durableWrite.eventId,
        universeId,
        data: durableEvent,
        createdAt: new Date('2026-08-14T12:00:00.000Z')
      }],
      storyBeats: [],
      storylines: [],
      canonContext: emptyCanonContext(universeId)
    });

    await expect(generateBooking('Book the next chapter.', universeId))
      .resolves.toBe('Generated booking');

    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    const generatedPrompt = pipelineInput?.input?.prompt ?? '';
    expect(generatedPrompt).toContain('Pending Wrestler (Overall 93)');
    expect(generatedPrompt).toContain('Pending Collision');
    expect(generatedPrompt).toContain('Pending betrayal');
    expect(generatedPrompt).toContain('pending-story: Pending championship arc.');
    expect(generatedPrompt.match(/Durable-only-marker/gu)).toHaveLength(1);
  });

  it('uses accepted non-durable roster entries when a repository roster read succeeds empty', async () => {
    const universeId = 'preactivation-simulation';
    mockRepository.updateRoster.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'updateRoster',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    await updateRoster([
      { name: 'Pending Alpha', overall: 92 },
      { name: 'Pending Beta', overall: 88 }
    ], universeId);
    mockRepository.loadRoster.mockResolvedValueOnce([]);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);

    try {
      const result = await simulateMatch(
        {
          wrestler1: 'Pending Alpha',
          wrestler2: 'Pending Beta',
          matchType: 'Singles'
        },
        [],
        0,
        universeId
      );

      expect(result.result.match).toBe('Pending Alpha vs Pending Beta (Singles)');
      expect(mockRepository.loadRoster).toHaveBeenCalledWith(universeId);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('does not let empty generation and simulation read misses evict pending continuity', async () => {
    const protectedUniverse = 'read-miss-protected-universe';
    mockGetPool.mockReturnValue(null);
    await updateRoster([
      { name: 'Protected Alpha', overall: 92 },
      { name: 'Protected Beta', overall: 88 }
    ], protectedUniverse);

    for (let index = 0; index < 17; index += 1) {
      await generateBooking('Book an empty universe.', `empty-generation-${index}`);
      await expect(simulateMatch(
        {
          wrestler1: 'Missing Alpha',
          wrestler2: 'Missing Beta',
          matchType: 'Singles'
        },
        [],
        0,
        `empty-simulation-${index}`
      )).rejects.toThrow('One or both wrestlers not found in roster');
    }

    mockGetPool.mockReturnValue({ kind: 'test-pool' });
    mockRepository.loadRoster.mockResolvedValueOnce([]);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const result = await simulateMatch(
        {
          wrestler1: 'Protected Alpha',
          wrestler2: 'Protected Beta',
          matchType: 'Singles'
        },
        [],
        0,
        protectedUniverse
      );

      expect(result.result.match).toBe('Protected Alpha vs Protected Beta (Singles)');
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('fails a 33rd pending universe honestly without discarding accepted state', async () => {
    mockGetPool.mockReturnValue(null);
    for (let index = 0; index < 32; index += 1) {
      const result = await updateRoster([
        { name: `Pending Alpha ${index}`, overall: 90 },
        { name: `Pending Beta ${index}`, overall: 80 }
      ], `pending-capacity-${index}`);
      expect(result.persistence.status).toBe('non_durable');
    }

    await expect(updateRoster(
      [{ name: 'Overflow Wrestler', overall: 85 }],
      'pending-capacity-overflow'
    )).rejects.toThrow(
      'Backstage Booker process fallback capacity is exhausted; mutation was not accepted.'
    );
    expect(mockSaveMemory).not.toHaveBeenCalledWith(
      'backstage-universe:pending-capacity-overflow:roster:latest',
      expect.anything()
    );

    mockGetPool.mockReturnValue({ kind: 'test-pool' });
    mockRepository.loadRoster.mockResolvedValueOnce([]);
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
    try {
      const retained = await simulateMatch(
        {
          wrestler1: 'Pending Alpha 0',
          wrestler2: 'Pending Beta 0',
          matchType: 'Singles'
        },
        [],
        0,
        'pending-capacity-0'
      );
      expect(retained.result.match).toBe('Pending Alpha 0 vs Pending Beta 0 (Singles)');
    } finally {
      randomSpy.mockRestore();
    }

    mockRepository.updateRoster.mockResolvedValueOnce({
      roster: [{ name: 'Durable Overflow', overall: 95 }],
      revision: '9900'
    });
    await expect(updateRoster(
      [{ name: 'Durable Overflow', overall: 95 }],
      'durable-over-capacity'
    )).resolves.toMatchObject({
      roster: [{ name: 'Durable Overflow', overall: 95 }],
      persistence: durablePersistence
    });
  });

  it('does not evict an existing universe while one of its mutations is in flight', async () => {
    for (let index = 0; index < 32; index += 1) {
      await bookEvent({ name: `seed-${index}` }, `active-capacity-${index}`);
    }

    let resolveActiveMutation: ((value: unknown) => void) | undefined;
    const activeMutation = new Promise<unknown>(resolve => {
      resolveActiveMutation = resolve;
    });
    mockRepository.updateRoster.mockImplementationOnce(async () => activeMutation);
    const activeRequest = updateRoster(
      [{ name: 'Protected In Flight', overall: 91 }],
      'active-capacity-0'
    );

    await bookEvent({ name: 'overflow-seed' }, 'active-capacity-overflow');
    expect(getBackstageBookerProcessStateStatsForTests('active-capacity-0').retainedEventCount)
      .toBe(1);
    expect(getBackstageBookerProcessStateStatsForTests('active-capacity-1').retainedEventCount)
      .toBe(0);
    expect(getBackstageBookerProcessStateStatsForTests('active-capacity-overflow').retainedEventCount)
      .toBe(1);

    resolveActiveMutation?.({
      roster: [{ name: 'Protected In Flight', overall: 91 }],
      revision: '9901'
    });
    await activeRequest;
    expect(getBackstageBookerProcessStateStatsForTests('active-capacity-0'))
      .toMatchObject({
        activeUniverseOperationCount: 0,
        activeMemorySnapshotOperationKeyCount: 0,
        memorySnapshotPublicationSequenceCount: 0
      });
  });

  it('keeps prior non-durable roster entries in a later durable response and snapshot', async () => {
    const universeId = 'mixed-roster-view';
    mockRepository.updateRoster.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'updateRoster',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    await updateRoster([{ name: 'Pending Alice', overall: 94 }], universeId);
    mockRepository.updateRoster.mockResolvedValueOnce({
      roster: [{ name: 'Durable Bob', overall: 90 }],
      revision: '700'
    });

    const result = await updateRoster(
      [{ name: 'Durable Bob', overall: 90 }],
      universeId
    );

    expect(result.roster).toEqual([
      { name: 'Durable Bob', overall: 90 },
      { name: 'Pending Alice', overall: 94 }
    ]);
    expect(result.persistence).toEqual(durablePersistence);
    expect(mockSaveMemory).toHaveBeenLastCalledWith(
      `backstage-universe:${universeId}:roster:latest`,
      expect.objectContaining({
        roster: result.roster,
        source: 'fallback',
        persistence: expect.objectContaining({ status: 'non_durable' })
      }),
      { ifNewerRevision: '700' }
    );
  });

  it('keeps prior non-durable beats in a later durable response and snapshot', async () => {
    const universeId = 'mixed-story-beat-view';
    const pendingBeat = { beat: 'Pending betrayal' };
    const durableBeat = { beat: 'Durable title challenge' };
    mockRepository.trackStoryline.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'trackStoryline',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    await trackStoryline(pendingBeat, universeId);
    mockRepository.trackStoryline.mockResolvedValueOnce({
      retainedBeats: [durableBeat],
      revision: '800'
    });

    const result = await trackStoryline(durableBeat, universeId);

    expect(result.beats).toEqual([pendingBeat, durableBeat]);
    expect(result.persistence).toEqual(durablePersistence);
    expect(mockSaveMemory).toHaveBeenLastCalledWith(
      `backstage-universe:${universeId}:storybeats:latest`,
      expect.objectContaining({
        beats: result.beats,
        source: 'fallback',
        persistence: expect.objectContaining({ status: 'non_durable' })
      }),
      { ifNewerRevision: '800' }
    );
  });

  it('keeps pending beats anchored before every later durable beat', async () => {
    const universeId = 'stable-story-beat-anchors';
    const pendingBeat = { beat: 'Pending challenge' };
    const firstDurableBeat = { beat: 'Durable contract signing' };
    const secondDurableBeat = { beat: 'Durable title match' };
    mockRepository.trackStoryline
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'trackStoryline',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      )
      .mockResolvedValueOnce({
        retainedBeats: [firstDurableBeat],
        revision: '801'
      })
      .mockResolvedValueOnce({
        retainedBeats: [firstDurableBeat, secondDurableBeat],
        revision: '802'
      });

    expect((await trackStoryline(pendingBeat, universeId)).beats).toEqual([
      pendingBeat
    ]);
    expect((await trackStoryline(firstDurableBeat, universeId)).beats).toEqual([
      pendingBeat,
      firstDurableBeat
    ]);
    const final = await trackStoryline(secondDurableBeat, universeId);

    expect(final.beats).toEqual([
      pendingBeat,
      firstDurableBeat,
      secondDurableBeat
    ]);
  });

  it('orders an older non-durable beat before a newer durable completion', async () => {
    const universeId = 'story-beat-inverse-operation-fence';
    const olderBeat = { beat: 'Older pending challenge' };
    const newerBeat = { beat: 'Newer durable response' };
    let rejectOlderMutation: ((reason?: unknown) => void) | undefined;
    const olderMutation = new Promise<never>((_resolve, reject) => {
      rejectOlderMutation = reject;
    });
    mockRepository.trackStoryline
      .mockImplementationOnce(async () => olderMutation)
      .mockResolvedValueOnce({ retainedBeats: [newerBeat], revision: '803' });

    const olderRequest = trackStoryline(olderBeat, universeId);
    const newerResult = await trackStoryline(newerBeat, universeId);
    rejectOlderMutation?.(
      new MockBackstageBookerWriteError(
        'trackStoryline',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    const olderResult = await olderRequest;

    expect(newerResult.beats).toEqual([newerBeat]);
    expect(olderResult.beats).toEqual([olderBeat, newerBeat]);
    expect(olderResult.persistence.status).toBe('non_durable');
    expect(mockSaveMemory).toHaveBeenLastCalledWith(
      `backstage-universe:${universeId}:storybeats:latest`,
      expect.objectContaining({
        beats: [olderBeat, newerBeat],
        source: 'fallback',
        persistence: expect.objectContaining({ status: 'non_durable' })
      })
    );
  });

  it('republishes the newest beat view after an older convenience write was in flight', async () => {
    const universeId = 'story-beat-memory-publication-fence';
    const memoryKey = `backstage-universe:${universeId}:storybeats:latest`;
    const olderBeat = { beat: 'Older durable beat' };
    const newerBeat = { beat: 'Newer pending beat' };
    let resolveOlderMemory: (() => void) | undefined;
    let markOlderMemoryStarted: (() => void) | undefined;
    const olderMemoryStarted = new Promise<void>(resolve => {
      markOlderMemoryStarted = resolve;
    });
    const olderMemory = new Promise<void>(resolve => {
      resolveOlderMemory = resolve;
    });
    let delayed = false;
    mockSaveMemory.mockImplementation((key: unknown) => {
      if (key === memoryKey && !delayed) {
        delayed = true;
        markOlderMemoryStarted?.();
        return olderMemory;
      }
      return Promise.resolve(undefined);
    });
    mockRepository.trackStoryline
      .mockResolvedValueOnce({ retainedBeats: [olderBeat], revision: '804' })
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'trackStoryline',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = trackStoryline(olderBeat, universeId);
    await olderMemoryStarted;
    const newerRequest = trackStoryline(newerBeat, universeId);
    await new Promise<void>(resolve => setImmediate(resolve));
    resolveOlderMemory?.();
    await Promise.all([olderRequest, newerRequest]);

    const memoryCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>).filter(([key]) => key === memoryKey);
    expect(memoryCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      beats: [olderBeat, newerBeat],
      source: 'fallback',
      persistence: expect.objectContaining({ status: 'non_durable' })
    }));
  });

  it('does not let an older durable completion erase a newer pending roster update', async () => {
    const universeId = 'roster-operation-fence';
    let resolveOlderMutation: ((value: unknown) => void) | undefined;
    const olderMutation = new Promise<unknown>(resolve => {
      resolveOlderMutation = resolve;
    });
    mockRepository.updateRoster
      .mockImplementationOnce(async () => olderMutation)
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'updateRoster',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = updateRoster(
      [{ name: 'Alex Star', overall: 80 }],
      universeId
    );
    const newerResult = await updateRoster(
      [{ name: 'Alex Star', overall: 96 }],
      universeId
    );
    expect(newerResult.roster).toEqual([{ name: 'Alex Star', overall: 96 }]);

    resolveOlderMutation?.({
      roster: [{ name: 'Alex Star', overall: 80 }],
      revision: '701'
    });
    const olderResult = await olderRequest;
    expect(olderResult.roster).toEqual([{ name: 'Alex Star', overall: 96 }]);

    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [{
        name: 'Alex Star',
        overall: 80,
        updatedAt: new Date('2026-08-14T12:00:00.000Z')
      }],
      events: [],
      storyBeats: [],
      storylines: [],
      canonContext: emptyCanonContext(universeId)
    });
    await generateBooking('Book the operation-fenced roster.', universeId);
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).toContain('Alex Star (Overall 96)');
    expect(pipelineInput?.input?.prompt).not.toContain('Alex Star (Overall 80)');
  });

  it('does not let an older non-durable roster completion override a newer durable wrestler', async () => {
    const universeId = 'roster-inverse-operation-fence';
    let rejectOlderMutation: ((reason?: unknown) => void) | undefined;
    const olderMutation = new Promise<never>((_resolve, reject) => {
      rejectOlderMutation = reject;
    });
    mockRepository.updateRoster
      .mockImplementationOnce(async () => olderMutation)
      .mockResolvedValueOnce({
        roster: [{ name: 'Alex Star', overall: 96 }],
        revision: '702'
      });

    const olderRequest = updateRoster(
      [{ name: 'Alex Star', overall: 80 }],
      universeId
    );
    const newerResult = await updateRoster(
      [{ name: 'Alex Star', overall: 96 }],
      universeId
    );
    rejectOlderMutation?.(
      new MockBackstageBookerWriteError(
        'updateRoster',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    const olderResult = await olderRequest;

    expect(newerResult.roster).toEqual([{ name: 'Alex Star', overall: 96 }]);
    expect(olderResult.roster).toEqual([{ name: 'Alex Star', overall: 96 }]);
    expect(olderResult.persistence.status).toBe('non_durable');
    expect(mockSaveMemory).toHaveBeenLastCalledWith(
      `backstage-universe:${universeId}:roster:latest`,
      expect.objectContaining({
        roster: [{ name: 'Alex Star', overall: 96 }],
        source: 'database',
        persistence: durablePersistence
      })
    );
  });

  it('republishes the newest roster after an older convenience write was in flight', async () => {
    const universeId = 'roster-memory-publication-fence';
    const memoryKey = `backstage-universe:${universeId}:roster:latest`;
    let resolveOlderMemory: (() => void) | undefined;
    let markOlderMemoryStarted: (() => void) | undefined;
    const olderMemoryStarted = new Promise<void>(resolve => {
      markOlderMemoryStarted = resolve;
    });
    const olderMemory = new Promise<void>(resolve => {
      resolveOlderMemory = resolve;
    });
    let delayed = false;
    mockSaveMemory.mockImplementation((key: unknown) => {
      if (key === memoryKey && !delayed) {
        delayed = true;
        markOlderMemoryStarted?.();
        return olderMemory;
      }
      return Promise.resolve(undefined);
    });
    mockRepository.updateRoster
      .mockResolvedValueOnce({
        roster: [{ name: 'Alex Star', overall: 80 }],
        revision: '703'
      })
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'updateRoster',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = updateRoster(
      [{ name: 'Alex Star', overall: 80 }],
      universeId
    );
    await olderMemoryStarted;
    const newerRequest = updateRoster(
      [{ name: 'Alex Star', overall: 96 }],
      universeId
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    resolveOlderMemory?.();
    await Promise.all([olderRequest, newerRequest]);

    const memoryCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>).filter(([key]) => key === memoryKey);
    expect(memoryCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      roster: [{ name: 'Alex Star', overall: 96 }],
      source: 'fallback',
      persistence: expect.objectContaining({ status: 'non_durable' })
    }));
  });

  it('reports process-memory persistence when the database is unavailable', async () => {
    mockGetPool.mockReturnValue(null);

    const result = await bookEvent({ name: 'Collision' }, 'offline-universe');

    expect(result.persistence).toEqual({
      status: 'non_durable',
      durable: false,
      backend: 'process-memory',
      degraded: true,
      reason: 'database_unavailable'
    });
    expect(mockCreateBackstageBookerRepository).not.toHaveBeenCalled();
    expect(mockRepository.bookEvent).not.toHaveBeenCalled();
  });

  it('reports a known pre-commit write failure as non-durable', async () => {
    mockRepository.bookEvent.mockRejectedValue(
      new MockBackstageBookerWriteError(
        'bookEvent',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );

    const result = await bookEvent({ name: 'Dynamite' }, 'write-failure-universe');

    expect(result.persistence).toEqual({
      status: 'non_durable',
      durable: false,
      backend: 'process-memory',
      degraded: true,
      reason: 'database_write_failed'
    });
    expect(mockRepository.bookEvent).toHaveBeenCalledTimes(1);
  });

  it('uses process fallback for a recognized nested transient write failure', async () => {
    const transientCause = Object.assign(new Error('connection reset'), {
      code: 'ECONNRESET'
    });
    mockRepository.bookEvent.mockRejectedValueOnce(
      new MockBackstageBookerWriteError('bookEvent', transientCause)
    );

    const result = await bookEvent({ name: 'Transient Event' }, 'transient-write');

    expect(result.persistence).toEqual({
      status: 'non_durable',
      durable: false,
      backend: 'process-memory',
      degraded: true,
      reason: 'database_write_failed'
    });
  });

  it('propagates unclassified integrity write failures without fallback effects', async () => {
    const writeError = new MockBackstageBookerWriteError(
      'bookEvent',
      Object.assign(new Error('duplicate key violates invariant'), { code: '23505' })
    );
    mockRepository.bookEvent.mockRejectedValueOnce(writeError);

    await expect(
      bookEvent({ name: 'Rejected Integrity Event' }, 'integrity-write')
    ).rejects.toBe(writeError);

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('propagates result-mapping failures wrapped by the write transaction', async () => {
    const writeError = new MockBackstageBookerWriteError(
      'bookEvent',
      new TypeError('Stored Backstage event data is not a JSON object.')
    );
    mockRepository.bookEvent.mockRejectedValueOnce(writeError);

    await expect(
      bookEvent({ name: 'Rejected Mapping Event' }, 'wrapped-mapping-write')
    ).rejects.toBe(writeError);

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('propagates an unclassified repository-unavailable wrapper', async () => {
    const unavailableError = new MockBackstageBookerRepositoryUnavailableError(
      'bookEvent',
      new Error('unexpected repository programming failure')
    );
    mockRepository.bookEvent.mockRejectedValueOnce(unavailableError);

    await expect(
      bookEvent({ name: 'Rejected Repository Event' }, 'repository-wrapper')
    ).rejects.toBe(unavailableError);

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('propagates repository result-mapping failures without fallback effects', async () => {
    mockRepository.updateRoster.mockResolvedValueOnce({ roster: 'not-an-array' });

    await expect(
      updateRoster([{ name: 'Mapping Failure', overall: 90 }], 'mapping-write')
    ).rejects.toThrow('Backstage roster repository returned an invalid roster.');

    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('reports an unknown commit outcome without retrying the write', async () => {
    mockRepository.bookEvent.mockRejectedValue(
      new MockBackstageBookerCommitUnknownError('bookEvent', new Error('connection lost during commit'))
    );

    const result = await bookEvent({ name: 'Forbidden Door' }, 'unknown-commit-universe');

    expect(result.persistence).toEqual({
      status: 'unknown',
      durable: null,
      backend: 'postgresql',
      degraded: true,
      reason: 'commit_outcome_unknown'
    });
    expect(mockGetPool).toHaveBeenCalledTimes(1);
    expect(mockCreateBackstageBookerRepository).toHaveBeenCalledTimes(1);
    expect(mockRepository.bookEvent).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('rethrows a legacy event commit-unknown without leaking it into fallback context', async () => {
    const commitUnknown = new MockBackstageBookerCommitUnknownError(
      'bookEvent',
      new Error('commit lost')
    );
    mockRepository.bookEvent.mockRejectedValueOnce(commitUnknown);

    await expect(bookEvent({ name: 'Uncertain Legacy Event' })).rejects.toBe(commitUnknown);

    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [],
      events: [],
      storyBeats: [],
      storylines: [],
      canonContext: emptyCanonContext('legacy')
    });
    await generateBooking('Book only confirmed continuity.', 'legacy');
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).not.toContain('Uncertain Legacy Event');
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('does not publish an unknown roster commit into fallback or convenience state', async () => {
    mockGetPool.mockReturnValue(null);
    await updateRoster([{ name: 'Confirmed Seed', overall: 90 }], 'unknown-roster');
    mockSaveMemory.mockClear();

    mockGetPool.mockReturnValue({ kind: 'test-pool' });
    mockRepository.updateRoster.mockRejectedValueOnce(
      new MockBackstageBookerCommitUnknownError('updateRoster', new Error('commit lost'))
    );
    const unknown = await updateRoster(
      [{ name: 'Uncertain Addition', overall: 91 }],
      'unknown-roster'
    );

    expect(unknown.persistence.status).toBe('unknown');
    expect(unknown.roster).toEqual([{ name: 'Confirmed Seed', overall: 90 }]);
    expect(mockRepository.updateRoster).toHaveBeenCalledTimes(1);
    expect(mockSaveMemory).not.toHaveBeenCalled();

    mockGetPool.mockReturnValue(null);
    const fallback = await updateRoster(
      [{ name: 'Confirmed Fallback', overall: 92 }],
      'unknown-roster'
    );
    expect(fallback.roster).toEqual([
      { name: 'Confirmed Fallback', overall: 92 },
      { name: 'Confirmed Seed', overall: 90 }
    ]);
    expect(fallback.roster).not.toContainEqual({ name: 'Uncertain Addition', overall: 91 });
  });

  it('returns an empty known view for an unknown roster commit with no local state', async () => {
    mockRepository.updateRoster.mockRejectedValueOnce(
      new MockBackstageBookerCommitUnknownError('updateRoster', new Error('commit lost'))
    );

    const unknown = await updateRoster(
      [{ name: 'Uncertain First Write', overall: 89 }],
      'unknown-empty-roster'
    );
    expect(unknown).toEqual({
      universeId: 'unknown-empty-roster',
      roster: [],
      persistence: {
        status: 'unknown',
        durable: null,
        backend: 'postgresql',
        degraded: true,
        reason: 'commit_outcome_unknown'
      }
    });
    expect(mockSaveMemory).not.toHaveBeenCalled();

    mockGetPool.mockReturnValue(null);
    const fallback = await updateRoster(
      [{ name: 'Confirmed Later', overall: 90 }],
      'unknown-empty-roster'
    );
    expect(fallback.roster).toEqual([{ name: 'Confirmed Later', overall: 90 }]);
  });

  it('does not append an unknown storyline commit to known or absent fallback state', async () => {
    mockGetPool.mockReturnValue(null);
    await trackStoryline({ beat: 'Confirmed seed' }, 'unknown-beats');
    mockSaveMemory.mockClear();

    mockGetPool.mockReturnValue({ kind: 'test-pool' });
    mockRepository.trackStoryline.mockRejectedValue(
      new MockBackstageBookerCommitUnknownError('trackStoryline', new Error('commit lost'))
    );
    const existing = await trackStoryline({ beat: 'Uncertain beat' }, 'unknown-beats');
    const absent = await trackStoryline({ beat: 'Uncertain first beat' }, 'unknown-empty-beats');

    expect(existing.beats).toEqual([{ beat: 'Confirmed seed' }]);
    expect(absent.beats).toEqual([]);
    expect(existing.persistence.status).toBe('unknown');
    expect(absent.persistence.status).toBe('unknown');
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('keeps process-memory roster fallback isolated by universe', async () => {
    mockGetPool.mockReturnValue(null);

    const alphaFirst = await updateRoster(
      [{ name: 'Alpha One', overall: 90 }],
      'fallback-alpha'
    );
    const beta = await updateRoster(
      [{ name: 'Beta One', overall: 85 }],
      'fallback-beta'
    );
    const alphaSecond = await updateRoster(
      [{ name: 'Alpha Two', overall: 88 }],
      'fallback-alpha'
    );

    expect(alphaFirst.roster).toEqual([{ name: 'Alpha One', overall: 90 }]);
    expect(beta.roster).toEqual([{ name: 'Beta One', overall: 85 }]);
    expect(alphaSecond.roster).toEqual([
      { name: 'Alpha One', overall: 90 },
      { name: 'Alpha Two', overall: 88 }
    ]);
    expect(alphaSecond.roster).not.toContainEqual({ name: 'Beta One', overall: 85 });
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-universe:fallback-alpha:roster:latest',
      expect.objectContaining({ universeId: 'fallback-alpha' })
    );
    expect(mockSaveMemory).toHaveBeenCalledWith(
      'backstage-universe:fallback-beta:roster:latest',
      expect.objectContaining({ universeId: 'fallback-beta' })
    );
  });

  it('allows additive universe rosters to grow beyond one request batch', async () => {
    mockGetPool.mockReturnValue(null);
    const initial = Array.from({ length: 100 }, (_unused, index) => ({
      name: `Roster Member ${index + 1}`,
      overall: index % 101
    }));

    await updateRoster(initial, 'large-additive-roster');
    const result = await updateRoster(
      [{ name: 'Roster Member 101', overall: 90 }],
      'large-additive-roster'
    );

    expect(result.roster).toHaveLength(101);
    expect(result.roster).toContainEqual({ name: 'Roster Member 101', overall: 90 });
  });

  it('accepts an authoritative roster larger than the mutation batch limit', async () => {
    const authoritative = Array.from({ length: 101 }, (_unused, index) => ({
      name: `Authoritative Member ${index + 1}`,
      overall: index % 101
    }));
    mockRepository.updateRoster.mockResolvedValueOnce({
      roster: authoritative,
      revision: '9001'
    });

    const result = await updateRoster(
      [{ name: 'Authoritative Member 101', overall: 100 }],
      'large-authoritative-roster'
    );

    expect(result.roster).toHaveLength(101);
    expect(result.persistence).toEqual(durablePersistence);
  });

  it('validates a mutation before database, memory, or audit effects', async () => {
    await expect(
      bookEvent({ invalid: Number.NaN }, 'validation-universe')
    ).rejects.toMatchObject({
      name: 'BackstageBookerContractError',
      action: 'bookEvent'
    });
    await expect(
      saveStoryline('', 'A valid storyline body.', 'validation-universe')
    ).rejects.toMatchObject({
      name: 'BackstageBookerContractError',
      action: 'saveStoryline'
    });

    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
    expect(mockGetPool).not.toHaveBeenCalled();
    expect(mockCreateBackstageBookerRepository).not.toHaveBeenCalled();
    expect(mockRepository.saveStoryline).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('skips audit and memory mirrors when a storyline commit is unknown', async () => {
    mockRepository.saveStoryline.mockRejectedValueOnce(
      new MockBackstageBookerCommitUnknownError('saveStoryline', new Error('commit lost'))
    );

    const result = await saveStoryline(
      'uncertain-story',
      'The challenger may have signed the contract.',
      'unknown-save'
    );

    expect(result.persistence.status).toBe('unknown');
    expect(result.saved).toBeNull();
    expect(mockRepository.saveStoryline).toHaveBeenCalledTimes(1);
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('persists contract-valid long storylines before attempting the legacy audit mirror', async () => {
    const storyline = 'x'.repeat(60_000);
    mockSaveWithAuditCheck.mockResolvedValueOnce(false);

    const result = await saveStoryline(
      '  long-form-main-event  ',
      storyline,
      'long-storyline'
    );

    expect(result).toEqual({
      universeId: 'long-storyline',
      key: 'long-form-main-event',
      saved: true,
      persistence: durablePersistence
    });
    expect(mockRepository.saveStoryline).toHaveBeenCalledWith(
      'long-storyline',
      'long-form-main-event',
      storyline
    );
    expect(mockRepository.saveStoryline.mock.invocationCallOrder[0]).toBeLessThan(
      mockSaveWithAuditCheck.mock.invocationCallOrder[0] as number
    );
  });

  it('keeps latest and hashed by-key mirrors distinct within the memory key limit', async () => {
    const universeId = `u${'n'.repeat(127)}`;
    const maximumKey = 'k'.repeat(240);

    await saveStoryline('latest', 'First storyline.', universeId);
    await saveStoryline(maximumKey, 'Second storyline.', universeId);

    const memoryCalls = mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>;
    const memoryKeys = memoryCalls.map(([memoryKey]) => memoryKey);
    const latestMemoryKey = `backstage-universe:${universeId}:storyline:latest`;
    const byKeyCalls = memoryCalls.filter(([memoryKey]) =>
      memoryKey.includes(':storyline:by-key:')
    );

    expect(memoryKeys.filter(memoryKey => memoryKey === latestMemoryKey)).toHaveLength(2);
    expect(byKeyCalls).toHaveLength(2);
    expect(byKeyCalls[0]?.[0]).not.toBe(byKeyCalls[1]?.[0]);
    expect(byKeyCalls.map(([, value]) => value.key)).toEqual(['latest', maximumKey]);
    expect(memoryKeys.every(memoryKey => memoryKey.length <= 255)).toBe(true);
  });

  it('bounds saved-storyline version and publication tracking across many distinct keys', async () => {
    const universeId = 'saved-storyline-tracking-stress';
    for (let index = 0; index < 1_000; index += 1) {
      await saveStoryline(
        `stress-key-${index}`,
        `Stress storyline ${index}.`,
        universeId
      );
      mockRepository.saveStoryline.mockClear();
      mockSaveMemory.mockClear();
      mockSaveWithAuditCheck.mockClear();
    }

    expect(getBackstageBookerProcessStateStatsForTests(universeId)).toMatchObject({
      savedStorylineVersionCount: 5,
      activeUniverseOperationCount: 0,
      activeMemorySnapshotOperationKeyCount: 0,
      activeMemorySnapshotOperationCount: 0,
      memorySnapshotPublicationSequenceCount: 0,
      memorySnapshotPublicationStateCount: 0
    });
  });

  it('retains an evicted same-key version fence until the older operation finishes', async () => {
    const universeId = 'saved-storyline-pruned-fence';
    const storylineKey = 'fenced-key';
    let resolveOlderSave: ((value: unknown) => void) | undefined;
    const olderSave = new Promise<unknown>(resolve => {
      resolveOlderSave = resolve;
    });
    const nonDurableError = new MockBackstageBookerWriteError(
      'saveStoryline',
      new MockBackstageBookerUniverseScopeNotActivatedError()
    );
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => olderSave)
      .mockRejectedValueOnce(nonDurableError)
      .mockRejectedValue(nonDurableError);

    const olderRequest = saveStoryline(
      storylineKey,
      'Older durable storyline must stay fenced.',
      universeId
    );
    await saveStoryline(
      storylineKey,
      'Newer pending storyline that will leave the bounded view.',
      universeId
    );
    for (let index = 0; index < 6; index += 1) {
      await saveStoryline(
        `newer-key-${index}`,
        `Newer pending storyline ${index}.`,
        universeId
      );
    }

    expect(getBackstageBookerProcessStateStatsForTests(universeId)).toMatchObject({
      savedStorylineVersionCount: 6,
      activeUniverseOperationCount: 1,
      activeMemorySnapshotOperationKeyCount: 2,
      activeMemorySnapshotOperationCount: 2,
      memorySnapshotPublicationSequenceCount: 2,
      memorySnapshotPublicationStateCount: 0
    });
    resolveOlderSave?.(savedStorylineMutation(
      universeId,
      storylineKey,
      'Older durable storyline must stay fenced.',
      '13001'
    ));
    await olderRequest;

    const memoryStorylines = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      { storyline?: string }
    ]>).map(([, value]) => value.storyline);
    const auditStorylines = (mockSaveWithAuditCheck.mock.calls as unknown as Array<[
      string,
      { storyline?: string }
    ]>).map(([, value]) => value.storyline);
    expect(memoryStorylines).not.toContain('Older durable storyline must stay fenced.');
    expect(auditStorylines).not.toContain('Older durable storyline must stay fenced.');
    expect(getBackstageBookerProcessStateStatsForTests(universeId)).toMatchObject({
      savedStorylineVersionCount: 5,
      activeUniverseOperationCount: 0,
      activeMemorySnapshotOperationKeyCount: 0,
      activeMemorySnapshotOperationCount: 0,
      memorySnapshotPublicationSequenceCount: 0,
      memorySnapshotPublicationStateCount: 0
    });
  });

  it('keeps a newer pending save visible when an older durable save finishes later', async () => {
    const universeId = 'saved-storyline-operation-fence';
    const storylineKey = 'main-event';
    let resolveOlderSave: ((value: unknown) => void) | undefined;
    const olderSave = new Promise<unknown>(resolve => {
      resolveOlderSave = resolve;
    });
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => olderSave)
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'saveStoryline',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = saveStoryline(
      storylineKey,
      'Older durable storyline.',
      universeId
    );
    const newerResult = await saveStoryline(
      storylineKey,
      'Newer pending storyline.',
      universeId
    );
    resolveOlderSave?.(savedStorylineMutation(
      universeId,
      storylineKey,
      'Older durable storyline.',
      '11001'
    ));
    const olderResult = await olderRequest;

    expect(newerResult.persistence.status).toBe('non_durable');
    expect(olderResult.persistence).toEqual(durablePersistence);

    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [],
      events: [],
      storyBeats: [],
      storylines: [{
        id: 'durable-old',
        universeId,
        storyKey: storylineKey,
        storyline: 'Older durable storyline.',
        createdAt: new Date('2026-08-14T12:00:00.000Z'),
        updatedAt: new Date('2026-08-14T12:00:00.000Z')
      }],
      canonContext: emptyCanonContext(universeId)
    });
    await generateBooking('Book the fenced saved storyline.', universeId);
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls.at(-1)?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    expect(pipelineInput?.input?.prompt).toContain('Newer pending storyline.');
    expect(pipelineInput?.input?.prompt).not.toContain('Older durable storyline.');

    const memoryCalls = mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>;
    const storylineCalls = memoryCalls.filter(([memoryKey]) => (
      memoryKey.includes(':storyline:latest')
      || memoryKey.includes(':storyline:by-key:')
    ));
    expect(storylineCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: storylineKey,
      storyline: 'Newer pending storyline.',
      source: 'fallback',
      persistence: expect.objectContaining({ status: 'non_durable' })
    }));
    expect(mockSaveWithAuditCheck.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: storylineKey,
      storyline: 'Newer pending storyline.'
    }));
  });

  it('does not let an older non-durable save override a newer durable same-key save', async () => {
    const universeId = 'saved-storyline-inverse-fence';
    const storylineKey = 'world-title';
    let rejectOlderSave: ((reason?: unknown) => void) | undefined;
    const olderSave = new Promise<never>((_resolve, reject) => {
      rejectOlderSave = reject;
    });
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => olderSave)
      .mockResolvedValueOnce(savedStorylineMutation(
        universeId,
        storylineKey,
        'Newer durable storyline.',
        '11002'
      ));

    const olderRequest = saveStoryline(
      storylineKey,
      'Older pending storyline.',
      universeId
    );
    const newerResult = await saveStoryline(
      storylineKey,
      'Newer durable storyline.',
      universeId
    );
    rejectOlderSave?.(
      new MockBackstageBookerWriteError(
        'saveStoryline',
        new MockBackstageBookerUniverseScopeNotActivatedError()
      )
    );
    const olderResult = await olderRequest;

    expect(newerResult.persistence).toEqual(durablePersistence);
    expect(olderResult.persistence.status).toBe('non_durable');
    const storylineCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>).filter(([memoryKey]) => (
      memoryKey.includes(':storyline:latest')
      || memoryKey.includes(':storyline:by-key:')
    ));
    expect(storylineCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: storylineKey,
      storyline: 'Newer durable storyline.',
      source: 'database',
      persistence: durablePersistence
    }));
    expect(mockSaveWithAuditCheck.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: storylineKey,
      storyline: 'Newer durable storyline.'
    }));
  });

  it('follows durable commit revision when same-key saves complete out of request order', async () => {
    const universeId = 'saved-storyline-durable-commit-fence';
    const storylineKey = 'world-title';
    let resolveFirstRequest: ((value: unknown) => void) | undefined;
    const firstMutation = new Promise<unknown>(resolve => {
      resolveFirstRequest = resolve;
    });
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => firstMutation)
      .mockResolvedValueOnce(savedStorylineMutation(
        universeId,
        storylineKey,
        'Second request, first commit.',
        '12001'
      ));

    const firstRequest = saveStoryline(
      storylineKey,
      'First request, final commit.',
      universeId
    );
    await saveStoryline(
      storylineKey,
      'Second request, first commit.',
      universeId
    );
    resolveFirstRequest?.(savedStorylineMutation(
      universeId,
      storylineKey,
      'First request, final commit.',
      '12002'
    ));
    await firstRequest;

    const storylineCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>,
      { ifNewerRevision?: string } | undefined
    ]>).filter(([memoryKey]) => (
      memoryKey.includes(':storyline:latest')
      || memoryKey.includes(':storyline:by-key:')
    ));
    for (const calls of [
      storylineCalls.filter(([memoryKey]) => memoryKey.includes(':storyline:latest')),
      storylineCalls.filter(([memoryKey]) => memoryKey.includes(':storyline:by-key:'))
    ]) {
      expect(calls.at(-1)?.[1]).toEqual(expect.objectContaining({
        key: storylineKey,
        storyline: 'First request, final commit.',
        revision: '12002'
      }));
      expect(calls.at(-1)?.[2]).toEqual({ ifNewerRevision: '12002' });
    }
  });

  it('follows durable commit revision for global latest across storyline keys', async () => {
    const universeId = 'saved-storyline-cross-key-durable-commit-fence';
    let resolveFirstRequest: ((value: unknown) => void) | undefined;
    const firstMutation = new Promise<unknown>(resolve => {
      resolveFirstRequest = resolve;
    });
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => firstMutation)
      .mockResolvedValueOnce(savedStorylineMutation(
        universeId,
        'second-key',
        'Second key, first commit.',
        '12003'
      ));

    const firstRequest = saveStoryline(
      'first-key',
      'First key, final commit.',
      universeId
    );
    await saveStoryline('second-key', 'Second key, first commit.', universeId);
    resolveFirstRequest?.(savedStorylineMutation(
      universeId,
      'first-key',
      'First key, final commit.',
      '12004'
    ));
    await firstRequest;

    const latestKey = `backstage-universe:${universeId}:storyline:latest`;
    const latestCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>,
      { ifNewerRevision?: string } | undefined
    ]>).filter(([memoryKey]) => memoryKey === latestKey);
    expect(latestCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: 'first-key',
      storyline: 'First key, final commit.',
      revision: '12004'
    }));
    expect(latestCalls.at(-1)?.[2]).toEqual({ ifNewerRevision: '12004' });
  });

  it('keeps global latest storyline ordered across different keys', async () => {
    const universeId = 'saved-storyline-global-latest-fence';
    let resolveOlderSave: ((value: unknown) => void) | undefined;
    const olderSave = new Promise<unknown>(resolve => {
      resolveOlderSave = resolve;
    });
    mockRepository.saveStoryline
      .mockImplementationOnce(async () => olderSave)
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'saveStoryline',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = saveStoryline('older-key', 'Older storyline.', universeId);
    await saveStoryline('newer-key', 'Newer storyline.', universeId);
    resolveOlderSave?.(savedStorylineMutation(
      universeId,
      'older-key',
      'Older storyline.',
      '11003'
    ));
    await olderRequest;

    const latestKey = `backstage-universe:${universeId}:storyline:latest`;
    const latestCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>).filter(([memoryKey]) => memoryKey === latestKey);
    const byKeyCalls = (mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>).filter(([memoryKey]) => memoryKey.includes(':storyline:by-key:'));

    expect(latestCalls.at(-1)?.[1]).toEqual(expect.objectContaining({
      key: 'newer-key',
      storyline: 'Newer storyline.'
    }));
    expect(byKeyCalls.map(([, value]) => value.key)).toEqual(expect.arrayContaining([
      'older-key',
      'newer-key'
    ]));
    expect(getBackstageBookerProcessStateStatsForTests(universeId)).toMatchObject({
      activeUniverseOperationCount: 0,
      activeMemorySnapshotOperationKeyCount: 0,
      activeMemorySnapshotOperationCount: 0,
      memorySnapshotPublicationSequenceCount: 0,
      memorySnapshotPublicationStateCount: 0
    });
  });

  it('republishes both saved-storyline mirrors after older writes were in flight', async () => {
    const universeId = 'saved-storyline-memory-publication-fence';
    const storylineKey = 'in-flight-key';
    const latestKey = `backstage-universe:${universeId}:storyline:latest`;
    let resolveLatestMemory: (() => void) | undefined;
    let resolveByKeyMemory: (() => void) | undefined;
    let markLatestStarted: (() => void) | undefined;
    let markByKeyStarted: (() => void) | undefined;
    const latestStarted = new Promise<void>(resolve => {
      markLatestStarted = resolve;
    });
    const byKeyStarted = new Promise<void>(resolve => {
      markByKeyStarted = resolve;
    });
    const latestMemory = new Promise<void>(resolve => {
      resolveLatestMemory = resolve;
    });
    const byKeyMemory = new Promise<void>(resolve => {
      resolveByKeyMemory = resolve;
    });
    mockSaveMemory.mockImplementation((memoryKey: unknown, value: unknown) => {
      const snapshot = value as { storyline?: unknown };
      if (snapshot.storyline === 'Older durable storyline.') {
        if (memoryKey === latestKey) {
          markLatestStarted?.();
          return latestMemory;
        }
        if (typeof memoryKey === 'string' && memoryKey.includes(':storyline:by-key:')) {
          markByKeyStarted?.();
          return byKeyMemory;
        }
      }
      return Promise.resolve(undefined);
    });
    mockRepository.saveStoryline
      .mockResolvedValueOnce(savedStorylineMutation(
        universeId,
        storylineKey,
        'Older durable storyline.',
        '11004'
      ))
      .mockRejectedValueOnce(
        new MockBackstageBookerWriteError(
          'saveStoryline',
          new MockBackstageBookerUniverseScopeNotActivatedError()
        )
      );

    const olderRequest = saveStoryline(
      storylineKey,
      'Older durable storyline.',
      universeId
    );
    await Promise.all([latestStarted, byKeyStarted]);
    const newerRequest = saveStoryline(
      storylineKey,
      'Newer pending storyline.',
      universeId
    );
    await new Promise<void>(resolve => setImmediate(resolve));
    resolveLatestMemory?.();
    resolveByKeyMemory?.();
    await Promise.all([olderRequest, newerRequest]);

    const memoryCalls = mockSaveMemory.mock.calls as unknown as Array<[
      string,
      Record<string, unknown>
    ]>;
    const latestCalls = memoryCalls.filter(([memoryKey]) => memoryKey === latestKey);
    const byKeyCalls = memoryCalls.filter(([memoryKey]) => (
      memoryKey.includes(':storyline:by-key:')
    ));
    for (const calls of [latestCalls, byKeyCalls]) {
      expect(calls.at(-1)?.[1]).toEqual(expect.objectContaining({
        key: storylineKey,
        storyline: 'Newer pending storyline.',
        source: 'fallback',
        persistence: expect.objectContaining({ status: 'non_durable' })
      }));
    }
  });

  it('rejects identical match participants before roster or HRC effects', async () => {
    await expect(simulateMatch(
      {
        wrestler1: 'Alex Star',
        wrestler2: '  Alex Star  ',
        matchType: 'Singles'
      },
      [{ name: 'Alex Star', overall: 90 }],
      0,
      'same-participant'
    )).rejects.toMatchObject({
      name: 'BackstageBookerContractError',
      action: 'simulateMatch'
    });

    expect(mockGetPool).not.toHaveBeenCalled();
    expect(mockEvaluateWithHRC).not.toHaveBeenCalled();
  });

  it('preserves case-sensitive wrestler identities in match simulation', async () => {
    const result = await simulateMatch(
      {
        wrestler1: 'Alex Star',
        wrestler2: 'alex star',
        matchType: 'Singles'
      },
      [
        { name: 'Alex Star', overall: 90 },
        { name: 'alex star', overall: 80 }
      ],
      0,
      'case-sensitive-participants'
    );

    expect(result.result.match).toBe('Alex Star vs alex star (Singles)');
    expect(mockEvaluateWithHRC).toHaveBeenCalledTimes(1);
  });

  it('normalizes and durably upserts a typed storyline with a deterministic fingerprint', async () => {
    mockRepository.upsertStoryline.mockResolvedValueOnce({
      mutationId: canonMutationId,
      revision: '20001',
      replayed: false,
      storyline: canonStorylineRecord()
    });

    const result = await upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId.toUpperCase(),
      expectedVersion: 0,
      storyline: {
        key: '  summer-feud  ',
        title: '  Summer Feud  ',
        summary: '  A rivalry built around the world championship.  ',
        status: 'active',
        participantNames: [' Alex Star ', 'Blake Stone']
      }
    });

    expect(result).toEqual({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      applied: true,
      universeRevision: '20001',
      storyline: {
        id: canonStorylineId,
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: 'A rivalry built around the world championship.',
        status: 'active',
        participantNames: ['Alex Star', 'Blake Stone'],
        version: 1,
        universeRevision: '20001',
        createdAt: '2026-08-14T15:00:00.000Z',
        updatedAt: '2026-08-14T15:00:00.000Z',
        closedAt: null
      },
      persistence: durablePersistence
    });
    const repositoryInput = mockRepository.upsertStoryline.mock.calls[0]?.[0] as {
      requestFingerprint?: string;
    };
    expect(repositoryInput).toEqual(expect.objectContaining({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storyKey: 'summer-feud',
      title: 'Summer Feud',
      summary: 'A rivalry built around the world championship.',
      expectedVersion: 0,
      participantNames: ['Alex Star', 'Blake Stone']
    }));
    expect(repositoryInput.requestFingerprint).toBe(buildBackstageCanonRequestFingerprint({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: 'A rivalry built around the world championship.',
        status: 'active',
        participantNames: ['Alex Star', 'Blake Stone']
      }
    }));
    expect(repositoryInput.requestFingerprint).toMatch(/^[0-9a-f]{64}$/u);
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
  });

  it('appends a durable canon beat with normalized UTC time and lifecycle status', async () => {
    const updatedStoryline = canonStorylineRecord({
      version: 2,
      updatedRevision: '20002',
      updatedAt: new Date('2026-08-15T02:01:00.000Z')
    });
    mockRepository.appendCanonBeat.mockResolvedValueOnce({
      mutationId: canonMutationId,
      revision: '20002',
      replayed: false,
      storyline: updatedStoryline,
      beat: canonBeatRecord()
    });

    const result = await appendCanonBeat({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storylineKey: ' summer-feud ',
      expectedVersion: 1,
      beat: {
        kind: 'development',
        summary: ' Alex interrupts Blake after the main event. ',
        occurredAt: '2026-08-15T02:00:00.000000000Z',
        participantNames: ['Alex Star', ' Blake Stone ']
      },
      nextStatus: 'active'
    });

    expect(result.applied).toBe(true);
    if (result.applied !== true) {
      throw new Error('Expected a durable canon beat result.');
    }
    expect(result.beat).toEqual(expect.objectContaining({
      id: canonBeatId,
      storylineId: canonStorylineId,
      storylineKey: 'summer-feud',
      sequence: 1,
      occurredAt: '2026-08-15T02:00:00.000Z',
      universeRevision: '20002'
    }));
    expect(result.storyline.version).toBe(2);
    expect(mockRepository.appendCanonBeat).toHaveBeenCalledWith(expect.objectContaining({
      storyKey: 'summer-feud',
      occurredAt: '2026-08-15T02:00:00.000Z',
      participantNames: ['Alex Star', 'Blake Stone'],
      eventId: null,
      supersedesBeatId: null,
      nextStatus: 'active',
      requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/u)
    }));
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('returns an unknown upsert receipt with no fallback or mirror side effects', async () => {
    mockRepository.upsertStoryline.mockRejectedValueOnce(
      new MockBackstageBookerCommitUnknownError('upsertStoryline', new Error('lost ack'))
    );

    await expect(upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames: []
      }
    })).resolves.toEqual({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      applied: null,
      universeRevision: null,
      storyline: null,
      persistence: {
        status: 'unknown',
        durable: null,
        backend: 'postgresql',
        degraded: true,
        reason: 'commit_outcome_unknown'
      }
    });
    expect(getBackstageBookerProcessStateStatsForTests('phase-two').universeCount).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
  });

  it('returns an unknown beat receipt without publishing the requested canon', async () => {
    mockRepository.appendCanonBeat.mockRejectedValueOnce(
      new MockBackstageBookerCommitUnknownError('appendCanonBeat', new Error('lost ack'))
    );

    await expect(appendCanonBeat({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storylineKey: 'summer-feud',
      expectedVersion: 1,
      beat: {
        kind: 'development',
        summary: 'A result whose commit is unknown.',
        occurredAt: '2026-08-15T02:00:00Z',
        participantNames: []
      }
    })).resolves.toEqual(expect.objectContaining({
      applied: null,
      universeRevision: null,
      storyline: null,
      beat: null,
      persistence: expect.objectContaining({ status: 'unknown' })
    }));
    expect(getBackstageBookerProcessStateStatsForTests('phase-two').universeCount).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('wraps only classified pre-commit canon outages and never falls back', async () => {
    mockRepository.upsertStoryline.mockRejectedValueOnce(
      new MockBackstageBookerRepositoryUnavailableError(
        'upsertStoryline',
        { code: 'ECONNREFUSED' }
      )
    );

    const request = {
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames: []
      }
    };
    const error = await upsertStoryline(request).catch((cause: unknown) => cause);
    expect(isBackstageCanonUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({
      code: BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
      httpStatus: 503,
      retryable: true,
      operation: 'upsertStoryline'
    });
    expect(getBackstageBookerProcessStateStatsForTests('phase-two').universeCount).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('classifies a transient rollback failure as canon unavailable', async () => {
    mockRepository.upsertStoryline.mockRejectedValueOnce(
      new MockBackstageBookerWriteError(
        'upsertStoryline',
        Object.assign(new Error('domain mutation was rejected before commit'), {
          code: '23514'
        }),
        Object.assign(new Error('rollback connection was lost'), {
          code: 'ECONNRESET'
        })
      )
    );

    const error = await upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames: []
      }
    }).catch((cause: unknown) => cause);

    expect(error).toMatchObject({
      code: BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE,
      httpStatus: 503,
      retryable: true,
      operation: 'upsertStoryline'
    });
    expect(isBackstageCanonUnavailableError(error)).toBe(true);
    expect(getBackstageBookerProcessStateStatsForTests('phase-two').universeCount).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
  });

  it('propagates unclassified canon write failures without fallback effects', async () => {
    const integrityFailure = new MockBackstageBookerWriteError(
      'appendCanonBeat',
      new Error('canon result violated an internal invariant')
    );
    mockRepository.appendCanonBeat.mockRejectedValueOnce(integrityFailure);

    await expect(appendCanonBeat({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storylineKey: 'summer-feud',
      expectedVersion: 1,
      beat: {
        kind: 'development',
        summary: 'A valid beat whose repository mapping fails.',
        occurredAt: '2026-08-15T02:00:00Z',
        participantNames: []
      }
    })).rejects.toBe(integrityFailure);

    expect(getBackstageBookerProcessStateStatsForTests('phase-two').universeCount).toBe(0);
    expect(mockSaveMemory).not.toHaveBeenCalled();
    expect(mockSaveWithAuditCheck).not.toHaveBeenCalled();
  });

  it('passes an idempotent repository replay through as the same durable response', async () => {
    const replay = {
      mutationId: canonMutationId,
      revision: '20001',
      replayed: true,
      storyline: canonStorylineRecord()
    };
    mockRepository.upsertStoryline.mockResolvedValue(replay);
    const request = {
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: 'A rivalry built around the world championship.',
        status: 'active',
        participantNames: ['Alex Star', 'Blake Stone']
      }
    };

    const first = await upsertStoryline(request);
    const replayed = await upsertStoryline(request);
    expect(replayed).toEqual(first);
    const fingerprints = mockRepository.upsertStoryline.mock.calls.map(
      call => (call[0] as { requestFingerprint: string }).requestFingerprint
    );
    expect(fingerprints).toEqual([fingerprints[0], fingerprints[0]]);
    expect(mockSaveMemory).not.toHaveBeenCalled();
  });

  it('advertises canon mutations as privileged confirmation-bound idempotent actions', () => {
    for (const action of ['upsertStoryline', 'appendCanonBeat'] as const) {
      expect(BackstageBookerModule.actionMetadata[action]).toEqual(expect.objectContaining({
        risk: 'privileged',
        requiresConfirmation: true,
        readOnly: false,
        idempotent: true
      }));
    }
    expect(BackstageBookerModule.actionMetadata.saveStoryline.idempotent).toBe(false);
    expect(BackstageBookerModule.actionMetadata.trackStoryline.idempotent).toBe(false);
  });

  it('renders bounded typed canon ahead of unchanged legacy continuity blocks', async () => {
    const activeCanonBeats = Array.from({ length: 14 }, (_unused, index) => (
      canonBeatRecord({
        sequence: index + 1,
        summary: `CANON-${String(index + 1).padStart(2, '0')}-END`,
        occurredAt: new Date(Date.UTC(2026, 7, 15, 2, index, 0))
      })
    ));
    mockRepository.loadContext.mockResolvedValueOnce({
      roster: [],
      events: [],
      storyBeats: [{
        data: { legacyBeat: 'Legacy continuity note' },
        createdAt: new Date('2026-08-13T10:00:00.000Z')
      }],
      storylines: [{
        id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        universeId: 'phase-two',
        storyKey: 'legacy-story',
        storyline: 'Legacy saved narrative',
        createdAt: new Date('2026-08-12T10:00:00.000Z'),
        updatedAt: new Date('2026-08-12T10:00:00.000Z')
      }],
      canonContext: {
        universeId: 'phase-two',
        revision: '20002',
        storylines: [canonStorylineRecord()],
        activeBeats: activeCanonBeats
      }
    });

    await generateBooking('Book the next chapter.', 'phase-two');
    const pipelineInput = mockRunTrinityWritingPipeline.mock.calls[0]?.[0] as {
      input?: { prompt?: string };
    } | undefined;
    const prompt = pipelineInput?.input?.prompt ?? '';
    expect(prompt).toContain('<<CANON_STORYLINES>>\n- Summer Feud [active]');
    expect(prompt).toContain('<<CANON_BEATS>>\n- 2026-08-15T02:02:00.000Z');
    expect(prompt).not.toContain('CANON-01-END');
    expect(prompt).not.toContain('CANON-02-END');
    expect(prompt).toContain('CANON-03-END');
    expect(prompt).toContain('CANON-14-END');
    expect(prompt.indexOf('CANON-03-END')).toBeLessThan(prompt.indexOf('CANON-14-END'));
    expect(prompt).toContain('Legacy continuity note');
    expect(prompt).toContain('Legacy saved narrative');
    expect(prompt.indexOf('<<CANON_BEATS>>')).toBeLessThan(
      prompt.indexOf('<<RECENT_STORY_BEATS>>')
    );
    expect(prompt.indexOf('<<CANON_STORYLINES>>')).toBeLessThan(
      prompt.indexOf('<<SAVED_STORYLINES>>')
    );
    expect(mockRepository.loadCanonContext).not.toHaveBeenCalled();
  });

  it('rejects invalid initial lifecycle and completion mutations before repository work', async () => {
    await expect(upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'paused',
        participantNames: []
      }
    })).rejects.toMatchObject({ name: 'BackstageBookerContractError' });

    await expect(appendCanonBeat({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storylineKey: 'summer-feud',
      expectedVersion: 1,
      beat: {
        kind: 'development',
        summary: 'This is not a payoff.',
        occurredAt: '2026-08-15T02:00:00Z',
        participantNames: []
      },
      nextStatus: 'completed'
    })).rejects.toMatchObject({ name: 'BackstageBookerContractError' });

    await expect(upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames: ['Alex Star', ' Alex Star ']
      }
    })).rejects.toMatchObject({ name: 'BackstageBookerContractError' });

    expect(mockRepository.upsertStoryline).not.toHaveBeenCalled();
    expect(mockRepository.appendCanonBeat).not.toHaveBeenCalled();
  });

  it('rejects PostgreSQL-invalid and unsupported canon timestamps before repository work', async () => {
    for (const occurredAt of [
      '0000-01-01T00:00:00Z',
      '2026-12-31T23:59:60Z'
    ]) {
      await expect(appendCanonBeat({
        universeId: 'phase-two',
        mutationId: canonMutationId,
        storylineKey: 'summer-feud',
        expectedVersion: 1,
        beat: {
          kind: 'development',
          summary: 'A timestamp boundary that must fail before persistence.',
          occurredAt,
          participantNames: []
        }
      })).rejects.toMatchObject({
        name: 'BackstageBookerContractError',
        action: 'appendCanonBeat',
        issues: expect.arrayContaining([
          expect.objectContaining({ instancePath: '/beat/occurredAt' })
        ])
      });
    }

    expect(mockRepository.appendCanonBeat).not.toHaveBeenCalled();
  });

  it('rejects oversized canon participant arrays as contract failures before repository work', async () => {
    const participantNames = Array.from(
      { length: 50 },
      (_unused, index) => `${'😀'.repeat(117)}-${String(index).padStart(2, '0')}`
    );

    await expect(upsertStoryline({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      expectedVersion: 0,
      storyline: {
        key: 'summer-feud',
        title: 'Summer Feud',
        summary: null,
        status: 'draft',
        participantNames
      }
    })).rejects.toMatchObject({
      name: 'BackstageBookerContractError',
      action: 'upsertStoryline',
      issues: expect.arrayContaining([
        expect.objectContaining({ instancePath: '/storyline/participantNames' })
      ])
    });

    await expect(appendCanonBeat({
      universeId: 'phase-two',
      mutationId: canonMutationId,
      storylineKey: 'summer-feud',
      expectedVersion: 1,
      beat: {
        kind: 'development',
        summary: 'A valid summary with an oversized participant encoding.',
        occurredAt: '2026-08-15T02:00:00Z',
        participantNames
      }
    })).rejects.toMatchObject({
      name: 'BackstageBookerContractError',
      action: 'appendCanonBeat',
      issues: expect.arrayContaining([
        expect.objectContaining({ instancePath: '/beat/participantNames' })
      ])
    });

    expect(mockRepository.upsertStoryline).not.toHaveBeenCalled();
    expect(mockRepository.appendCanonBeat).not.toHaveBeenCalled();
  });
});
