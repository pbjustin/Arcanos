import express from 'express';

import {
  createGenericJobsRouter,
  type GenericJobData,
} from './routes/genericJobsRouter.js';
import {
  applyBackstageStorylineMutation,
} from './core/db/repositories/backstageStorylineRepository.js';
import {
  NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT,
  NATIVE_PR_PREVIEW_FIXTURE_IDS,
  NATIVE_PR_PREVIEW_MODE,
  NATIVE_PR_PREVIEW_RESEARCH_CONTRACT,
  NATIVE_PR_PREVIEW_TRUST_SCOPE,
  type NativePrPreviewIdentity,
} from './nativePrPreviewContract.js';
import {
  buildResearchStorageTopicComponent,
  isResearchRequestValidationError,
  normalizeResearchHttpRequest,
  RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
  RESEARCH_TOPIC_MAX_LENGTH,
  RESEARCH_URL_MAX_ITEMS,
  RESEARCH_URL_MAX_LENGTH,
  RESEARCH_URLS_MAX_AGGREGATE_LENGTH,
  type NormalizedResearchRequest,
  type ResearchRequestInput,
} from './shared/researchRequest.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
  BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS,
  isBackstageStorylineValidationError,
  parseBackstageStorylinePayload,
  parseBackstageStorylineSerializedPayload,
  selectBackstageStorylineResponseBeats,
  type StorylineBeat,
} from './shared/backstage/backstageStoryline.js';
import {
  sendBoundedJsonResponse,
} from './shared/http/sendBoundedJsonResponse.js';

const MAX_REQUEST_BYTES = 4 * 1024;
const MAX_RESEARCH_RESPONSE_BYTES = 4 * 1024;
const MAX_STORYLINE_RESPONSE_BYTES = 4 * 1024;
const CONTENT_LENGTH_PATTERN = /^(?:0|[1-9]\d*)$/u;
const FIXTURE_ACTOR_KEY = 'operator:native-pr-preview-fixture';
const FIXTURE_TIMESTAMP = new Date('2026-07-30T00:00:00.000Z');
const FIXTURE_COMPLETED_TIMESTAMP = new Date('2026-07-30T00:00:01.000Z');
const SAFE_SOURCE_COMMIT_PATTERN = /^[0-9a-f]{40}$/u;
const FORBIDDEN_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'mcp-session-id',
  'x-action-secret',
  'x-confirmed',
  'x-one-time-token',
  'x-openai-action-secret',
  'x-session-id',
]);
const SENSITIVE_HEADER_SEGMENT_PATTERN =
  /(?:^|-)(?:authorization|cookie|credential|key|secret|session|token)(?:-|$)/u;
const RESEARCH_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures)
);
const STORYLINE_FIXTURE_NAMES = new Set<string>(
  Object.values(NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures)
);
const SNAPSHOT_FIRST_URL = 'https://example.invalid/first-snapshot';
const SNAPSHOT_SECOND_URL = 'https://example.invalid/second-snapshot';
const STORAGE_COMPONENT_TOPIC = 'abcdefghijklmnopqrstuvwxyz0123456789';

export interface NativePrPreviewReadinessState {
  applicationImported: boolean;
  draining: boolean;
  fixturesSealed: boolean;
  ready: boolean;
}

export interface NativePrPreviewApplicationOptions {
  identity: NativePrPreviewIdentity;
  readinessState: NativePrPreviewReadinessState;
}

class NativePrPreviewRepositoryUnavailableError extends Error {}

interface SyntheticResearchFixture {
  input: ResearchRequestInput;
  observeSnapshot?: (
    normalized: NormalizedResearchRequest
  ) => Record<string, unknown>;
}

interface SyntheticResearchResult {
  payload: Record<string, unknown>;
  statusCode: number;
}

interface SyntheticStorylineResult {
  payload: Record<string, unknown>;
  statusCode: number;
}

interface StorylineFixtureRow {
  id: string;
  serializedData: string;
  storageSequence: number;
}

const STORYLINE_TRANSACTION_PHASES = Object.freeze([
  'isolation',
  'advisory-lock',
  'table-write-fence',
  'revision',
  'legacy-backfill',
  'null-cleanup',
  'prune',
  'compact',
  'insert',
  'fresh-read',
]);

function buildSyntheticResearchFixture(
  fixture: string
): SyntheticResearchFixture {
  const fixtures = NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures;
  switch (fixture) {
    case fixtures.topicExact:
      return {
        input: {
          topic: '😀'.repeat(RESEARCH_TOPIC_MAX_LENGTH / 2),
          urls: [],
        },
      };
    case fixtures.topicOver:
      return {
        input: {
          topic:
            `${'😀'.repeat(RESEARCH_TOPIC_MAX_LENGTH / 2)}x`,
          urls: [],
        },
      };
    case fixtures.urlCountExact:
      return {
        input: {
          topic: 'URL count boundary',
          urls: Array.from(
            { length: RESEARCH_URL_MAX_ITEMS },
            () => ' '
          ),
        },
      };
    case fixtures.urlCountOver:
      return {
        input: {
          topic: 'URL count over boundary',
          urls: Array.from(
            { length: RESEARCH_URL_MAX_ITEMS + 1 },
            () => ' '
          ),
        },
      };
    case fixtures.urlItemExact:
      return {
        input: {
          topic: 'URL item boundary',
          urls: ['😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)],
        },
      };
    case fixtures.urlItemOver:
      return {
        input: {
          topic: 'URL item over boundary',
          urls: [
            `${'😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)}x`,
          ],
        },
      };
    case fixtures.urlAggregateExact:
      return {
        input: {
          topic: 'URL aggregate boundary',
          urls: Array.from(
            {
              length:
                RESEARCH_URLS_MAX_AGGREGATE_LENGTH
                / RESEARCH_URL_MAX_LENGTH,
            },
            () => '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)
          ),
        },
      };
    case fixtures.urlAggregateOver:
      return {
        input: {
          topic: 'URL aggregate over boundary',
          urls: [
            ...Array.from(
              {
                length:
                  RESEARCH_URLS_MAX_AGGREGATE_LENGTH
                  / RESEARCH_URL_MAX_LENGTH,
              },
              () => '😀'.repeat(RESEARCH_URL_MAX_LENGTH / 2)
            ),
            'x',
          ],
        },
      };
    case fixtures.urlSnapshot: {
      const sourceUrls = [` ${SNAPSHOT_FIRST_URL} `];
      let descriptorReads = 0;
      const urls = new Proxy(sourceUrls, {
        getOwnPropertyDescriptor(target, property) {
          const descriptor = Object.getOwnPropertyDescriptor(target, property);
          if (property !== '0' || !descriptor || !('value' in descriptor)) {
            return descriptor;
          }
          descriptorReads += 1;
          return {
            ...descriptor,
            value:
              descriptorReads === 1
                ? ` ${SNAPSHOT_FIRST_URL} `
                : SNAPSHOT_SECOND_URL,
          };
        },
      });
      return {
        input: { topic: 'URL snapshot', urls },
        observeSnapshot(normalized) {
          sourceUrls[0] = SNAPSHOT_SECOND_URL;
          return {
            descriptorReads,
            normalizedUrl: normalized.urls[0],
            sourceMutationIsolated:
              normalized.urls[0] === SNAPSHOT_FIRST_URL,
          };
        },
      };
    }
    case fixtures.storageComponent:
      return {
        input: { topic: STORAGE_COMPONENT_TOPIC, urls: [] },
      };
    default:
      throw new Error('PREVIEW_RESEARCH_FIXTURE_INVALID');
  }
}

function summarizeNormalizedResearchRequest(
  normalized: NormalizedResearchRequest
): Record<string, number> {
  let urlAggregateLength = 0;
  let urlItemMaxLength = 0;
  for (const url of normalized.urls) {
    urlAggregateLength += url.length;
    urlItemMaxLength = Math.max(urlItemMaxLength, url.length);
  }
  return {
    topicLength: normalized.topic.length,
    urlAggregateLength,
    urlCount: normalized.urls.length,
    urlItemMaxLength,
  };
}

function runSyntheticResearchFixture(fixture: string): SyntheticResearchResult {
  const syntheticFixture = buildSyntheticResearchFixture(fixture);
  let normalized: NormalizedResearchRequest;
  try {
    normalized = normalizeResearchHttpRequest(syntheticFixture.input);
  } catch (error) {
    if (!isResearchRequestValidationError(error)) {
      throw error;
    }
    return {
      statusCode: 400,
      payload: {
        accepted: false,
        confirmationAttempted: false,
        effectsBoundaryReached: false,
        eligibleForConfirmation: false,
        fixture,
        postValidationBoundaryReached: false,
        protectedEffectsEnabled: false,
        schemaVersion: 1,
        validationCompleted: true,
        validationCode: error.code,
      },
    };
  }

  // This marker is intentionally only a post-validation sentinel. The
  // contained preview never imports confirmGate or crosses an effects boundary.
  const payload: Record<string, unknown> = {
    accepted: true,
    confirmationAttempted: false,
    effectsBoundaryReached: false,
    eligibleForConfirmation: true,
    fixture,
    normalized: summarizeNormalizedResearchRequest(normalized),
    postValidationBoundaryReached: true,
    protectedEffectsEnabled: false,
    schemaVersion: 1,
    validationCompleted: true,
    validationCode: 'VALID',
  };

  if (syntheticFixture.observeSnapshot) {
    payload.snapshot = syntheticFixture.observeSnapshot(normalized);
  }
  if (
    fixture
    === NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.fixtures.storageComponent
  ) {
    const first = buildResearchStorageTopicComponent(normalized.topic);
    const second = buildResearchStorageTopicComponent(normalized.topic);
    const bytes = Buffer.byteLength(first, 'utf8');
    payload.storage = {
      ascii: /^[\x00-\x7f]+$/u.test(first),
      bytes,
      component: first,
      deterministic: first === second,
      maxBytes: RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
      portablePattern: /^[a-z0-9-]+-[a-f0-9]{64}$/u.test(first),
      withinLimit:
        bytes <= RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES,
    };
  }

  return { payload, statusCode: 200 };
}

function requireStorylineFixtureInvariant(
  condition: boolean,
  code: string
): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function storylineFixtureId(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function storylineSequence(beat: StorylineBeat): number {
  const sequence = beat.sequence;
  requireStorylineFixtureInvariant(
    Number.isSafeInteger(sequence),
    'PREVIEW_BACKSTAGE_STORYLINE_SEQUENCE_INVALID'
  );
  return sequence as number;
}

function buildStorylineBeatAtSerializedBytes(
  sequence: number,
  targetBytes: number
): StorylineBeat {
  const empty = { sequence, padding: '' };
  const envelopeBytes = Buffer.byteLength(JSON.stringify(empty), 'utf8');
  const paddingBytes = targetBytes - envelopeBytes;
  requireStorylineFixtureInvariant(
    paddingBytes >= 0,
    'PREVIEW_BACKSTAGE_STORYLINE_BYTE_FIXTURE_INVALID'
  );
  const emojiCount = Math.floor(paddingBytes / 4);
  const asciiCount = paddingBytes - (emojiCount * 4);
  const beat = {
    sequence,
    padding: `${'😀'.repeat(emojiCount)}${'x'.repeat(asciiCount)}`,
  };
  requireStorylineFixtureInvariant(
    Buffer.byteLength(JSON.stringify(beat), 'utf8') === targetBytes,
    'PREVIEW_BACKSTAGE_STORYLINE_BYTE_FIXTURE_INVALID'
  );
  return beat;
}

function compareStorylineFixtureRows(
  left: StorylineFixtureRow,
  right: StorylineFixtureRow
): number {
  const sequenceOrder = left.storageSequence - right.storageSequence;
  if (sequenceOrder !== 0 || left.id === right.id) {
    return sequenceOrder;
  }
  return left.id < right.id ? -1 : 1;
}

function createStorylineTransactionFixture(initialBeats: readonly StorylineBeat[]) {
  let rows: StorylineFixtureRow[] = initialBeats.map((beat, index) => ({
    id: storylineFixtureId(index + 1),
    serializedData: JSON.stringify(beat),
    storageSequence: index + 1,
  }));
  let nextIdSequence = initialBeats.length + 1;
  let nextRevision = 9_001;
  const phases: string[] = [];

  function recordPhase(phase: string): void {
    const expected =
      STORYLINE_TRANSACTION_PHASES[phases.length % STORYLINE_TRANSACTION_PHASES.length];
    requireStorylineFixtureInvariant(
      phase === expected,
      'PREVIEW_BACKSTAGE_STORYLINE_TRANSACTION_PHASE_INVALID'
    );
    phases.push(phase);
  }

  const query = async (
    queryText: unknown,
    parameters: readonly unknown[] = []
  ): Promise<{ rows: unknown[] }> => {
    requireStorylineFixtureInvariant(
      typeof queryText === 'string',
      'PREVIEW_BACKSTAGE_STORYLINE_QUERY_INVALID'
    );
    const sql = queryText.replace(/\s+/gu, ' ').trim();

    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') {
      recordPhase('isolation');
      return { rows: [] };
    }
    if (sql.includes('SELECT pg_advisory_xact_lock')) {
      recordPhase('advisory-lock');
      requireStorylineFixtureInvariant(
        parameters.length === 2
        && parameters.every(value => Number.isSafeInteger(value)),
        'PREVIEW_BACKSTAGE_STORYLINE_LOCK_INVALID'
      );
      return { rows: [] };
    }
    if (
      sql
      === 'LOCK TABLE backstage_story_beats IN SHARE ROW EXCLUSIVE MODE'
    ) {
      recordPhase('table-write-fence');
      requireStorylineFixtureInvariant(
        parameters.length === 0,
        'PREVIEW_BACKSTAGE_STORYLINE_TABLE_LOCK_INVALID'
      );
      return { rows: [] };
    }
    if (sql === 'SELECT txid_current()::TEXT AS revision') {
      recordPhase('revision');
      const revision = String(nextRevision);
      nextRevision += 1;
      return { rows: [{ revision }] };
    }
    if (sql.startsWith('WITH newest_legacy AS MATERIALIZED')) {
      recordPhase('legacy-backfill');
      requireStorylineFixtureInvariant(
        parameters[0] === BACKSTAGE_STORYLINE_MAX_BYTES
        && parameters[1] === BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
        'PREVIEW_BACKSTAGE_STORYLINE_LEGACY_BOUND_INVALID'
      );
      return { rows: [] };
    }
    if (
      sql
      === 'DELETE FROM backstage_story_beats WHERE serialized_data IS NULL'
    ) {
      recordPhase('null-cleanup');
      return { rows: [] };
    }
    if (sql.startsWith('WITH expired AS MATERIALIZED')) {
      recordPhase('prune');
      const retainedBeforeInsert = BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS - 1;
      requireStorylineFixtureInvariant(
        parameters[0] === retainedBeforeInsert,
        'PREVIEW_BACKSTAGE_STORYLINE_RETENTION_BOUND_INVALID'
      );
      rows = [...rows]
        .sort(compareStorylineFixtureRows)
        .slice(-retainedBeforeInsert);
      return { rows: [] };
    }
    if (sql.startsWith('WITH ordered AS MATERIALIZED')) {
      recordPhase('compact');
      rows = [...rows]
        .sort(compareStorylineFixtureRows)
        .map((row, index) => ({ ...row, storageSequence: index + 1 }));
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO backstage_story_beats')) {
      recordPhase('insert');
      const serializedData = parameters[0];
      parseBackstageStorylineSerializedPayload(serializedData);
      const id = storylineFixtureId(nextIdSequence);
      nextIdSequence += 1;
      rows.push({
        id,
        serializedData: serializedData as string,
        storageSequence:
          Math.max(0, ...rows.map(row => row.storageSequence)) + 1,
      });
      return { rows: [{ id }] };
    }
    if (sql.startsWith('SELECT recent.serialized_data')) {
      recordPhase('fresh-read');
      const insertedId = parameters[0];
      const limit = parameters[1];
      requireStorylineFixtureInvariant(
        typeof insertedId === 'string'
        && limit === BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
        'PREVIEW_BACKSTAGE_STORYLINE_READ_BOUND_INVALID'
      );
      const selected = [...rows]
        .sort((left, right) => {
          const leftInserted = left.id === insertedId;
          const rightInserted = right.id === insertedId;
          if (leftInserted !== rightInserted) {
            return leftInserted ? -1 : 1;
          }
          return right.storageSequence - left.storageSequence
            || (right.id < left.id ? -1 : 1);
        })
        .slice(0, BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS)
        .sort(compareStorylineFixtureRows);
      return {
        rows: selected.map(row => ({
          serialized_data: row.serializedData,
        })),
      };
    }

    throw new Error('PREVIEW_BACKSTAGE_STORYLINE_QUERY_INVALID');
  };

  return {
    client: { query } as unknown as Parameters<
      typeof applyBackstageStorylineMutation
    >[0],
    phases,
  };
}

function requireStorylineSequences(
  beats: readonly StorylineBeat[],
  first: number,
  last: number
): number[] {
  const expected = Array.from(
    { length: last - first + 1 },
    (_, index) => first + index
  );
  const actual = beats.map(storylineSequence);
  requireStorylineFixtureInvariant(
    actual.length === expected.length
    && actual.every((sequence, index) => sequence === expected[index]),
    'PREVIEW_BACKSTAGE_STORYLINE_ORDER_INVALID'
  );
  return actual;
}

async function runStorylineLifecycleFixture(
  fixture: string
): Promise<SyntheticStorylineResult> {
  const exactPayload = parseBackstageStorylinePayload(
    buildStorylineBeatAtSerializedBytes(
      101,
      BACKSTAGE_STORYLINE_MAX_BYTES
    )
  );
  const exactSerialized = JSON.stringify(exactPayload);
  const initialBeats = Array.from({ length: 100 }, (_, index) => {
    const sequence = index + 1;
    return parseBackstageStorylinePayload(
      sequence === 2
        ? { sequence, occurredAt: '1900-01-01T00:00:00.000Z' }
        : { sequence }
    );
  });
  const transactionFixture = createStorylineTransactionFixture(initialBeats);
  const firstMutation = await applyBackstageStorylineMutation(
    transactionFixture.client,
    exactSerialized
  );
  const firstSequences = requireStorylineSequences(
    firstMutation.retainedBeats,
    2,
    101
  );
  const firstResponse = selectBackstageStorylineResponseBeats(
    firstMutation.retainedBeats
  );
  const firstResponseSequences = requireStorylineSequences(
    firstResponse,
    77,
    101
  );

  const secondPayload = parseBackstageStorylinePayload({ sequence: 102 });
  const secondMutation = await applyBackstageStorylineMutation(
    transactionFixture.client,
    JSON.stringify(secondPayload)
  );
  const secondSequences = requireStorylineSequences(
    secondMutation.retainedBeats,
    3,
    102
  );
  const secondResponse = selectBackstageStorylineResponseBeats(
    secondMutation.retainedBeats
  );
  const finalResponseSequences = requireStorylineSequences(
    secondResponse,
    78,
    102
  );
  const firstAncientBeatRetained = firstMutation.retainedBeats.some(
    beat => storylineSequence(beat) === 2
      && beat.occurredAt === '1900-01-01T00:00:00.000Z'
  );
  const firstAcceptedBeatIncluded =
    firstSequences.filter(sequence => sequence === 101).length === 1;
  const secondAcceptedBeatIncluded =
    secondSequences.filter(sequence => sequence === 102).length === 1;
  const freshReadObservedPriorAcceptedBeat =
    secondSequences.filter(sequence => sequence === 101).length === 1;

  requireStorylineFixtureInvariant(
    Buffer.byteLength(exactSerialized, 'utf8')
      === BACKSTAGE_STORYLINE_MAX_BYTES
    && firstAncientBeatRetained
    && firstAcceptedBeatIncluded
    && secondAcceptedBeatIncluded
    && freshReadObservedPriorAcceptedBeat
    && transactionFixture.phases.length
      === STORYLINE_TRANSACTION_PHASES.length * 2,
    'PREVIEW_BACKSTAGE_STORYLINE_LIFECYCLE_INVALID'
  );

  return {
    statusCode: 200,
    payload: {
      accepted: true,
      confirmationAttempted: false,
      databaseBoundaryReached: false,
      effectsBoundaryReached: false,
      eligibleForConfirmation: true,
      fixture,
      durablePersistenceAttempted: false,
      postValidationBoundaryReached: true,
      protectedEffectsEnabled: false,
      schemaVersion: 1,
      transactionComponentExecuted: true,
      validationCompleted: true,
      validationCode: 'VALID',
      lifecycle: {
        exactBytes: BACKSTAGE_STORYLINE_MAX_BYTES,
        finalResponseSequences,
        firstAcceptedBeatIncluded,
        firstAncientBeatRetained,
        firstNewestSequence: firstSequences.at(-1),
        firstOldestSequence: firstSequences[0],
        firstResponseFirstSequence: firstResponseSequences[0],
        firstResponseLastSequence: firstResponseSequences.at(-1),
        freshReadObservedPriorAcceptedBeat,
        mutationCount: 2,
        queryPhaseCount: transactionFixture.phases.length,
        responseCount: secondResponse.length,
        responseLimit: BACKSTAGE_STORYLINE_MAX_RESPONSE_BEATS,
        retainedCount: secondMutation.retainedBeats.length,
        retentionLimit: BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
        secondAcceptedBeatIncluded,
        secondNewestSequence: secondSequences.at(-1),
        secondOldestSequence: secondSequences[0],
        transactionPhaseOrderVerified: true,
      },
    },
  };
}

function runStorylinePayloadOverFixture(
  fixture: string
): SyntheticStorylineResult {
  try {
    parseBackstageStorylinePayload(
      buildStorylineBeatAtSerializedBytes(
        101,
        BACKSTAGE_STORYLINE_MAX_BYTES + 1
      )
    );
  } catch (error) {
    if (!isBackstageStorylineValidationError(error)) {
      throw error;
    }
    return {
      statusCode: 400,
      payload: {
        accepted: false,
        confirmationAttempted: false,
        databaseBoundaryReached: false,
        effectsBoundaryReached: false,
        eligibleForConfirmation: false,
        fixture,
        durablePersistenceAttempted: false,
        postValidationBoundaryReached: false,
        protectedEffectsEnabled: false,
        schemaVersion: 1,
        transactionComponentExecuted: false,
        validationCompleted: true,
        validationCode: error.code,
      },
    };
  }
  throw new Error('PREVIEW_BACKSTAGE_STORYLINE_OVER_LIMIT_ACCEPTED');
}

async function runStorylineFixture(
  fixture: string
): Promise<SyntheticStorylineResult> {
  const fixtures = NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.fixtures;
  switch (fixture) {
    case fixtures.lifecycleExact:
      return runStorylineLifecycleFixture(fixture);
    case fixtures.payloadOver:
      return runStorylinePayloadOverFixture(fixture);
    default:
      throw new Error('PREVIEW_BACKSTAGE_STORYLINE_FIXTURE_INVALID');
  }
}

function cloneJob(job: GenericJobData): GenericJobData {
  const cloned = structuredClone(job);
  for (const [key, value] of Object.entries(job)) {
    if (Object.prototype.toString.call(value) === '[object Date]') {
      (cloned as unknown as Record<string, unknown>)[key] =
        new Date((value as Date).getTime());
    }
  }
  return cloned;
}

function buildFixture(
  id: string,
  status: GenericJobData['status'],
  overrides: Partial<GenericJobData> = {}
): GenericJobData {
  return Object.freeze({
    id,
    worker_id: 'native-pr-preview-fixture',
    job_type: 'gpt',
    status,
    claim_generation: '0',
    input: {
      requestPath: '/gpt/arcanos-preview',
      executionModeReason: 'native_pr_preview_fixture',
    },
    output: null,
    error_message: null,
    created_at: FIXTURE_TIMESTAMP,
    updated_at: FIXTURE_TIMESTAMP,
    completed_at: undefined,
    cancel_requested_at: null,
    cancel_reason: null,
    ...overrides,
  }) as GenericJobData;
}

function createSealedFixtureRepository() {
  const fixtures = new Map<string, GenericJobData>([
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.completed,
        'completed',
        {
          output: {
            ok: true,
            result: { answer: 'synthetic preview result' },
          },
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.failed,
        'failed',
        {
          error_message: 'Synthetic preview failure.',
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
      buildFixture(NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable, 'pending'),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
        'completed',
        {
          output: {
            ok: true,
            result: { answer: 'synthetic terminal result' },
          },
          completed_at: FIXTURE_COMPLETED_TIMESTAMP,
          updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        }
      ),
    ],
    [
      NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
      buildFixture(
        NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
        'pending'
      ),
    ],
  ]);

  return Object.freeze({
    async getJobById(jobId: string): Promise<GenericJobData | null> {
      if (jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable) {
        throw new NativePrPreviewRepositoryUnavailableError();
      }
      const fixture = fixtures.get(jobId);
      return fixture ? cloneJob(fixture) : null;
    },
    async requestJobCancellation(jobId: string) {
      if (
        jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable
        || jobId ===
          NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable
      ) {
        throw new NativePrPreviewRepositoryUnavailableError();
      }
      const fixture = fixtures.get(jobId);
      if (!fixture) {
        return { outcome: 'not_found' as const, job: null };
      }
      if (
        fixture.status === 'completed'
        || fixture.status === 'failed'
        || fixture.status === 'cancelled'
        || fixture.status === 'expired'
      ) {
        return {
          outcome: 'already_terminal' as const,
          job: cloneJob(fixture),
        };
      }

      const cancelled = cloneJob({
        ...fixture,
        status: 'cancelled',
        updated_at: FIXTURE_COMPLETED_TIMESTAMP,
        completed_at: FIXTURE_COMPLETED_TIMESTAMP,
        cancel_requested_at: FIXTURE_COMPLETED_TIMESTAMP,
        cancel_reason: 'Synthetic preview cancellation.',
      });
      return {
        outcome: 'cancelled' as const,
        job: cancelled,
      };
    },
  });
}

function validateIdentity(identity: NativePrPreviewIdentity): void {
  if (
    !Number.isSafeInteger(identity.prNumber)
    || identity.prNumber < 1
    || !SAFE_SOURCE_COMMIT_PATTERN.test(identity.sourceCommit)
  ) {
    throw new Error('PREVIEW_APPLICATION_IDENTITY_INVALID');
  }
}

function isCredentialCarrierPresent(request: express.Request): boolean {
  return Object.keys(request.headers).some((rawHeaderName) => {
    const headerName = rawHeaderName.toLowerCase();
    return FORBIDDEN_HEADER_NAMES.has(headerName)
      || SENSITIVE_HEADER_SEGMENT_PATTERN.test(headerName)
      || headerName.startsWith('x-arcanos-')
      || headerName.startsWith('x-openai-');
  });
}

function buildAllowedRouteKeys(): Set<string> {
  const allowed = new Set([
    'GET /health',
    'HEAD /health',
    'GET /healthz',
    'HEAD /healthz',
    'GET /readyz',
    'HEAD /readyz',
    `POST ${NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path}`,
    `POST ${NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path}`,
    'GET /jobs/not-a-uuid',
    'GET /jobs/not-a-uuid/result',
    'POST /jobs/not-a-uuid/cancel',
  ]);
  for (const jobId of Object.values(NATIVE_PR_PREVIEW_FIXTURE_IDS)) {
    allowed.add(`GET /jobs/${jobId}`);
    allowed.add(`GET /jobs/${jobId}/result`);
  }
  for (const jobId of [
    NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.terminal,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.repositoryUnavailable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.missing,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized,
    NATIVE_PR_PREVIEW_FIXTURE_IDS.cancellationUnavailable,
  ]) {
    allowed.add(`POST /jobs/${jobId}/cancel`);
  }
  return allowed;
}

function sendFixedNotFound(
  request: express.Request,
  response: express.Response
): void {
  response.status(404);
  response.type('text/plain');
  response.send(request.method === 'HEAD' ? undefined : 'not found');
}

export function createNativePrPreviewReadinessState():
NativePrPreviewReadinessState {
  return {
    applicationImported: false,
    draining: false,
    fixturesSealed: false,
    ready: false,
  };
}

export function createNativePrPreviewApplication(
  options: NativePrPreviewApplicationOptions
): express.Express {
  validateIdentity(options.identity);
  const app = express();
  const allowedRouteKeys = buildAllowedRouteKeys();
  const fixtureRepository = createSealedFixtureRepository();
  const jsonBodyParser = express.json({
    limit: MAX_REQUEST_BYTES,
    strict: true,
  });

  app.disable('x-powered-by');
  app.use((request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    const rawUrl = request.url ?? '';
    const rawPath = rawUrl.split('?', 1)[0] ?? '';
    const routeKey = `${request.method ?? ''} ${rawPath}`;
    const contentLength = request.header('content-length');
    const parsedContentLength = contentLength === undefined
      ? 0
      : Number.parseInt(contentLength, 10);
    const isPost = request.method === 'POST';
    const contentType = request.header('content-type') ?? '';

    if (
      rawUrl.includes('?')
      || rawPath.includes('%')
      || !allowedRouteKeys.has(routeKey)
      || isCredentialCarrierPresent(request)
      || request.header('content-encoding') !== undefined
      || request.header('transfer-encoding') !== undefined
      || (
        contentLength !== undefined
        && !CONTENT_LENGTH_PATTERN.test(contentLength)
      )
      || !Number.isSafeInteger(parsedContentLength)
      || parsedContentLength < 0
      || parsedContentLength > MAX_REQUEST_BYTES
      || (!isPost && parsedContentLength !== 0)
      || (
        isPost
        && (
          parsedContentLength < 1
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(
            contentType
          )
        )
      )
    ) {
      sendFixedNotFound(request, response);
      return;
    }
    next();
  });

  app.get(['/health', '/healthz'], (_request, response) => {
    response.type('text/plain').send('ok');
  });

  app.get('/readyz', (_request, response) => {
    const ready =
      options.readinessState.ready
      && options.readinessState.applicationImported
      && options.readinessState.fixturesSealed
      && !options.readinessState.draining;
    response.status(ready ? 200 : 503).json({
      applicationImported: options.readinessState.applicationImported,
      fixturesSealed: options.readinessState.fixturesSealed,
      mode: NATIVE_PR_PREVIEW_MODE,
      prNumber: options.identity.prNumber,
      processKind: 'web',
      protectedEffectsEnabled: false,
      protectsMaliciousPr: false,
      ready,
      requiresPlatformSecretIsolationForUntrustedCode: true,
      sourceCommit: options.identity.sourceCommit,
      trustScope: NATIVE_PR_PREVIEW_TRUST_SCOPE,
    });
  });

  app.use((request, response, next) => {
    if (request.method !== 'POST') {
      next();
      return;
    }
    jsonBodyParser(request, response, next);
  });

  app.post(
    NATIVE_PR_PREVIEW_RESEARCH_CONTRACT.path,
    (request, response) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !RESEARCH_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_RESEARCH_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.research_fixture_invalid',
            maxBytes: MAX_RESEARCH_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      const result = runSyntheticResearchFixture(fixture);
      return sendBoundedJsonResponse(
        request,
        response,
        result.payload,
        {
          logEvent: 'native_pr_preview.research_fixture',
          maxBytes: MAX_RESEARCH_RESPONSE_BYTES,
          statusCode: result.statusCode,
        }
      );
    }
  );

  app.post(
    NATIVE_PR_PREVIEW_BACKSTAGE_STORYLINE_CONTRACT.path,
    (request, response, next) => {
      const body = request.body as unknown;
      const bodyKeys =
        body && typeof body === 'object' && !Array.isArray(body)
          ? Object.keys(body)
          : [];
      const fixture =
        bodyKeys.length === 1 && bodyKeys[0] === 'fixture'
          ? (body as { fixture?: unknown }).fixture
          : undefined;
      if (
        typeof fixture !== 'string'
        || !STORYLINE_FIXTURE_NAMES.has(fixture)
      ) {
        return sendBoundedJsonResponse(
          request,
          response,
          { error: 'PREVIEW_BACKSTAGE_STORYLINE_FIXTURE_INVALID' },
          {
            logEvent: 'native_pr_preview.backstage_storyline_fixture_invalid',
            maxBytes: MAX_STORYLINE_RESPONSE_BYTES,
            statusCode: 400,
          }
        );
      }

      void runStorylineFixture(fixture)
        .then(result => sendBoundedJsonResponse(
          request,
          response,
          result.payload,
          {
            logEvent: 'native_pr_preview.backstage_storyline_fixture',
            maxBytes: MAX_STORYLINE_RESPONSE_BYTES,
            statusCode: result.statusCode,
          }
        ))
        .catch(next);
      return undefined;
    }
  );

  app.use('/', createGenericJobsRouter({
    confirmCancellation: (_request, _response, next) => next(),
    getJobById: fixtureRepository.getJobById,
    getRequestActorKey: () => FIXTURE_ACTOR_KEY,
    getRequestEstablishedActorKey: () => FIXTURE_ACTOR_KEY,
    isJobRepositoryUnavailable: (error) =>
      error instanceof NativePrPreviewRepositoryUnavailableError,
    recordJobLookup: () => undefined,
    requestJobCancellation: fixtureRepository.requestJobCancellation,
    sleep: async () => {
      throw new Error('PREVIEW_APPLICATION_STREAM_DISABLED');
    },
    validateBridgeCredential: () => ({
      ok: false,
      statusCode: 503,
      reason: 'unconfigured',
    }),
    verifyJobReadCapability: (jobId) => {
      if (jobId === NATIVE_PR_PREVIEW_FIXTURE_IDS.authUnavailable) {
        return { available: false, authorized: false };
      }
      return {
        available: true,
        authorized:
          jobId !== NATIVE_PR_PREVIEW_FIXTURE_IDS.unauthorized,
      };
    },
  }));

  app.use((request, response) => {
    sendFixedNotFound(request, response);
  });

  app.use((
    _error: unknown,
    _request: express.Request,
    response: express.Response,
    _next: express.NextFunction
  ) => {
    response.setHeader('Cache-Control', 'no-store');
    response.status(400).json({ error: 'PREVIEW_REQUEST_INVALID' });
  });

  return app;
}
