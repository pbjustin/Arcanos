import { createHash } from 'node:crypto';
import { jest } from '@jest/globals';
import type { JobData } from '../src/core/db/schema.js';
import {
  BackstageNotionPartitionSyncInProgressError,
  BackstageNotionPartitionSyncQueueSaturatedError,
  IdempotencyKeyConflictError,
  JobRepositoryUnavailableError,
  type FindOrCreateBackstageNotionPartitionSyncJobOptions,
  type FindOrCreateBackstageNotionPartitionSyncJobResult,
} from '../src/core/db/repositories/jobRepository.js';
import {
  BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME,
  BACKSTAGE_NOTION_PARTITIONS_ENV_NAME,
} from '../src/shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
  BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
  BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
  type BackstageNotionPartitionSyncJobInput,
  type BackstageNotionPartitionSyncJobResult,
} from '../src/shared/jobs/backstageNotionPartitionSyncJob.js';
import {
  enqueueBackstageNotionPartitionSyncOperation,
  getBackstageNotionPartitionSyncOperationStatus,
} from '../src/services/backstageNotionPartitionSyncOperations.js';

const SYNC_ID = '019fe3cd-8c01-7f01-8d2d-caa951bc4b9b';
const MANIFEST_ID = '019fe3cd-8c01-7f01-8d2d-caa951bc4ba0';
const SNAPSHOT_ID = '019fe3cd-8c01-7f01-8d2d-caa951bc4ba1';
const UNIVERSE_ID = 'my-universe:2k26';
const SHARD_KEY = 'archive/raw-2025';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_KEY = 'operator:credential:actor-a';
const IDEMPOTENCY_KEY = 'partition-sync-key-0001';
const NOW = new Date('2026-08-24T12:00:00.000Z');

const VALID_CONFIGURATION = JSON.stringify({
  version: 1,
  generation: 'authority-2026.08.24-1',
  universes: [{
    universeId: UNIVERSE_ID,
    shards: [{
      shardKey: SHARD_KEY,
      rootPageId: ROOT_PAGE_ID,
      displayName: 'Raw recovery archive',
      retrievalTier: 'archive',
      required: false,
      scopeTags: ['brand:raw', 'year:2025'],
      categoryTags: ['archive'],
      capacity: {
        maxPages: 256,
        maxChunks: 2048,
        maxDepth: 16,
        maxContentCodePoints: 2_000_000,
      },
    }],
  }],
});

function hashActorScope(actorKey: string): string {
  return createHash('sha256')
    .update('arcanos:backstage-notion-partition-sync:actor-scope:v1', 'utf8')
    .update('\0', 'utf8')
    .update(actorKey, 'utf8')
    .digest('hex');
}

function readValidEnvironment(name: string): string | undefined {
  if (name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME) {
    return 'shadow';
  }
  if (name === BACKSTAGE_NOTION_PARTITIONS_ENV_NAME) {
    return VALID_CONFIGURATION;
  }
  return undefined;
}

function jobInput(overrides: Partial<BackstageNotionPartitionSyncJobInput> = {}): BackstageNotionPartitionSyncJobInput {
  return {
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    universeId: UNIVERSE_ID,
    shardKey: SHARD_KEY,
    configurationGeneration: 'authority-2026.08.24-1',
    configurationDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function completedResult(
  overrides: Partial<BackstageNotionPartitionSyncJobResult> = {}
): BackstageNotionPartitionSyncJobResult {
  return {
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_RESULT_PROTOCOL,
    version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
    outcome: 'synchronized',
    safeReasonCode: null,
    universeId: UNIVERSE_ID,
    shardKey: SHARD_KEY,
    fullSourceScan: true,
    manifestStatus: 'published',
    manifestId: MANIFEST_ID,
    freshSnapshotId: SNAPSHOT_ID,
    pageCount: 12,
    chunkCount: 31,
    pageVersionReuseCount: 9,
    embeddedChunkCount: 7,
    pageChanges: {
      added: 1,
      changed: 2,
      moved: 1,
      deleted: 0,
      unchanged: 8,
    },
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobData> = {}): JobData {
  return {
    id: SYNC_ID,
    worker_id: 'backstage-notion-partition-sync',
    job_type: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE,
    status: 'pending',
    claim_generation: '0',
    input: jobInput(),
    idempotency_scope_hash: hashActorScope(ACTOR_KEY),
    created_at: new Date('2026-08-24T12:00:00.000Z'),
    updated_at: new Date('2026-08-24T12:02:00.000Z'),
    ...overrides,
  };
}

function buildAdmissionMock() {
  return jest.fn<(
    options: FindOrCreateBackstageNotionPartitionSyncJobOptions
  ) => Promise<FindOrCreateBackstageNotionPartitionSyncJobResult>>(async options => ({
    job: makeJob({
      input: options.input,
      idempotency_scope_hash: options.idempotencyScopeHash,
    }),
    created: true,
    deduped: false,
    dedupeReason: 'new_job',
  }));
}

function enqueueInput(
  findOrCreateSyncJob = buildAdmissionMock(),
  overrides: Record<string, unknown> = {}
) {
  return {
    universeId: UNIVERSE_ID,
    body: {
      version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
      shardKey: SHARD_KEY,
    },
    actorKey: ACTOR_KEY,
    idempotencyKey: IDEMPOTENCY_KEY,
    correlationId: 'request-123',
    dependencies: {
      readEnvironment: readValidEnvironment,
      findOrCreateSyncJob,
      now: () => NOW,
      workerId: 'partition-sync-worker',
    },
    ...overrides,
  };
}

describe('Backstage Notion partition synchronization operations', () => {
  it('resolves one exact configured shard and persists only hashes and the closed job contract', async () => {
    const findOrCreateSyncJob = buildAdmissionMock();

    const response = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob)
    );

    expect(response).toEqual({
      statusCode: 202,
      payload: {
        ok: true,
        syncId: SYNC_ID,
        universeId: UNIVERSE_ID,
        shardKey: SHARD_KEY,
        status: 'queued',
        deduplicated: false,
        statusUrl: `/api/backstage/notion-partitions/${encodeURIComponent(UNIVERSE_ID)}/syncs/${SYNC_ID}`,
      },
    });
    expect(findOrCreateSyncJob).toHaveBeenCalledTimes(1);
    const admission = findOrCreateSyncJob.mock.calls[0]?.[0];
    expect(admission).toMatchObject({
      workerId: 'partition-sync-worker',
      universeId: UNIVERSE_ID,
      shardKey: SHARD_KEY,
      correlationId: 'request-123',
      idempotencyUntil: new Date('2026-08-25T12:00:00.000Z'),
      input: {
        protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
        version: BACKSTAGE_NOTION_PARTITION_SYNC_REQUEST_VERSION,
        universeId: UNIVERSE_ID,
        shardKey: SHARD_KEY,
        configurationGeneration: 'authority-2026.08.24-1',
      },
    });
    expect(admission?.idempotencyScopeHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(admission?.idempotencyKeyHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(admission?.requestFingerprintHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(admission?.idempotencyScopeHash).not.toContain(ACTOR_KEY);
    expect(admission?.idempotencyKeyHash).not.toContain(IDEMPOTENCY_KEY);
    const serializedAdmission = JSON.stringify(admission);
    expect(serializedAdmission).not.toContain(ACTOR_KEY);
    expect(serializedAdmission).not.toContain(IDEMPOTENCY_KEY);
    expect(serializedAdmission).not.toContain(ROOT_PAGE_ID);
    expect(serializedAdmission).not.toContain('Raw recovery archive');
    expect(JSON.stringify(response)).not.toContain(ROOT_PAGE_ID);
  });

  it('uses actor-scoped key hashes while keeping request fingerprints independent of the actor', async () => {
    const firstAdmission = buildAdmissionMock();
    const secondAdmission = buildAdmissionMock();

    await enqueueBackstageNotionPartitionSyncOperation(enqueueInput(firstAdmission));
    await enqueueBackstageNotionPartitionSyncOperation(enqueueInput(
      secondAdmission,
      { actorKey: 'operator:credential:actor-b' }
    ));

    const first = firstAdmission.mock.calls[0]?.[0];
    const second = secondAdmission.mock.calls[0]?.[0];
    expect(first?.idempotencyScopeHash).not.toBe(second?.idempotencyScopeHash);
    expect(first?.idempotencyKeyHash).not.toBe(second?.idempotencyKeyHash);
    expect(first?.requestFingerprintHash).toBe(second?.requestFingerprintHash);
  });

  it('returns 200 for an exact-key replay and 202 only for newly queued work', async () => {
    const findOrCreateSyncJob = buildAdmissionMock();
    findOrCreateSyncJob.mockImplementationOnce(async options => ({
      job: makeJob({
        status: 'running',
        input: options.input,
        idempotency_scope_hash: options.idempotencyScopeHash,
      }),
      created: false,
      deduped: true,
      dedupeReason: 'reused_explicit_key',
    }));

    const response = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob)
    );

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      status: 'running',
      deduplicated: true,
    });
  });

  it('rejects disabled, unavailable, malformed, and unknown targets before queue admission', async () => {
    const findOrCreateSyncJob = buildAdmissionMock();
    const disabledReader = jest.fn((name: string) => (
      name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
        ? 'monolith'
        : (() => { throw new Error('configuration must not be read'); })()
    ));

    const disabled = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, {
        dependencies: {
          readEnvironment: disabledReader,
          findOrCreateSyncJob,
          now: () => NOW,
        },
      })
    );
    const unavailable = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, {
        dependencies: {
          readEnvironment: (name: string) => (
            name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
              ? 'shadow'
              : '{'
          ),
          findOrCreateSyncJob,
          now: () => NOW,
        },
      })
    );
    const malformed = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, {
        body: { version: 1, shardKey: SHARD_KEY, rootPageId: ROOT_PAGE_ID },
      })
    );
    const unknown = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, {
        body: { version: 1, shardKey: 'archive/unknown' },
      })
    );
    const malformedUniverse = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, { universeId: '__proto__' })
    );

    expect(disabled.statusCode).toBe(409);
    expect(disabled.payload).toMatchObject({
      error: { code: 'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED' },
    });
    expect(disabledReader).toHaveBeenCalledTimes(1);
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.payload).toMatchObject({
      error: { code: 'BACKSTAGE_NOTION_PARTITION_SYNC_CONFIGURATION_UNAVAILABLE' },
    });
    expect(malformed.statusCode).toBe(400);
    expect(unknown.statusCode).toBe(404);
    expect(malformedUniverse.payload).toEqual(unknown.payload);
    expect(findOrCreateSyncJob).not.toHaveBeenCalled();
  });

  it('rejects exact partitioned mode before configuration or queue admission', async () => {
    const findOrCreateSyncJob = buildAdmissionMock();
    const readEnvironment = jest.fn((name: string) => (
      name === BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE_ENV_NAME
        ? 'partitioned'
        : (() => { throw new Error('configuration must remain unread'); })()
    ));

    const response = await enqueueBackstageNotionPartitionSyncOperation(
      enqueueInput(findOrCreateSyncJob, {
        dependencies: {
          readEnvironment,
          findOrCreateSyncJob,
          now: () => NOW,
        },
      })
    );

    expect(response.statusCode).toBe(409);
    expect(response.payload).toMatchObject({
      error: { code: 'BACKSTAGE_NOTION_PARTITION_SYNC_DISABLED' },
    });
    expect(readEnvironment).toHaveBeenCalledTimes(1);
    expect(findOrCreateSyncJob).not.toHaveBeenCalled();
  });

  it('maps repository admission failures to closed responses without raw error text', async () => {
    const cases: Array<{
      error: Error;
      statusCode: number;
      code: string;
      retryAfterSeconds?: number;
    }> = [
      {
        error: new IdempotencyKeyConflictError('private-key-material'),
        statusCode: 409,
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_IDEMPOTENCY_CONFLICT',
      },
      {
        error: new BackstageNotionPartitionSyncInProgressError('private-root'),
        statusCode: 409,
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_IN_PROGRESS',
        retryAfterSeconds: 5,
      },
      {
        error: new BackstageNotionPartitionSyncQueueSaturatedError('private-config'),
        statusCode: 429,
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_QUEUE_SATURATED',
        retryAfterSeconds: 30,
      },
      {
        error: new JobRepositoryUnavailableError('private-database-detail'),
        statusCode: 503,
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_JOBS_UNAVAILABLE',
        retryAfterSeconds: 30,
      },
      {
        error: new Error('provider-secret-and-root'),
        statusCode: 500,
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_INTERNAL_ERROR',
      },
    ];

    for (const testCase of cases) {
      const response = await enqueueBackstageNotionPartitionSyncOperation(
        enqueueInput(jest.fn(async () => { throw testCase.error; }))
      );
      expect(response.statusCode).toBe(testCase.statusCode);
      expect(response.payload).toMatchObject({ error: { code: testCase.code } });
      expect(response.retryAfterSeconds).toBe(testCase.retryAfterSeconds);
      expect(JSON.stringify(response)).not.toContain(testCase.error.message);
    }
  });

  it('returns a bounded actor-owned completion projection without job input or raw errors', async () => {
    const getJob = jest.fn(async () => makeJob({
      status: 'completed',
      output: completedResult(),
      error_message: 'provider-token-private',
      completed_at: new Date('2026-08-24T12:01:00.000Z'),
    }));

    const response = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: { getJob },
    });

    expect(response).toEqual({
      statusCode: 200,
      payload: {
        ok: true,
        syncId: SYNC_ID,
        universeId: UNIVERSE_ID,
        shardKey: SHARD_KEY,
        status: 'completed',
        result: {
          outcome: 'synchronized',
          safeReasonCode: null,
          fullSourceScan: true,
          manifestStatus: 'published',
          manifestId: MANIFEST_ID,
          freshSnapshotId: SNAPSHOT_ID,
          pageCount: 12,
          chunkCount: 31,
          pageVersionReuseCount: 9,
          embeddedChunkCount: 7,
          pageChanges: {
            added: 1,
            changed: 2,
            moved: 1,
            deleted: 0,
            unchanged: 8,
          },
        },
        createdAt: '2026-08-24T12:00:00.000Z',
        updatedAt: '2026-08-24T12:02:00.000Z',
        completedAt: '2026-08-24T12:01:00.000Z',
      },
    });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('provider-token-private');
    expect(serialized).not.toContain('configurationGeneration');
    expect(serialized).not.toContain('configurationDigest');
    expect(serialized).not.toContain('protocol');
  });

  it('accepts the database null completed_at value for active jobs', async () => {
    const response = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: {
        getJob: async () => makeJob({
          status: 'running',
          completed_at: null as unknown as Date,
        }),
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.payload).toMatchObject({
      status: 'running',
      result: null,
      completedAt: null,
    });
  });

  it('uses the same not-found response for missing, malformed, cross-actor, and wrong-contract jobs', async () => {
    const expected = {
      statusCode: 404,
      payload: {
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
          message: 'The partition synchronization was not found.',
        },
      },
    };
    const invalidIdGetJob = jest.fn(async () => makeJob());
    const invalidId = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: 'not-a-uuid',
      actorKey: ACTOR_KEY,
      dependencies: { getJob: invalidIdGetJob },
    });
    expect(invalidId).toEqual(expected);
    expect(invalidIdGetJob).not.toHaveBeenCalled();

    const jobs: Array<JobData | null> = [
      null,
      makeJob({ idempotency_scope_hash: hashActorScope('another-actor') }),
      makeJob({ job_type: 'gpt' }),
      makeJob({ input: { ...jobInput(), rootPageId: ROOT_PAGE_ID } }),
      makeJob({ input: jobInput({ universeId: 'another-universe' }) }),
    ];
    for (const job of jobs) {
      const response = await getBackstageNotionPartitionSyncOperationStatus({
        universeId: UNIVERSE_ID,
        syncId: SYNC_ID,
        actorKey: ACTOR_KEY,
        dependencies: { getJob: async () => job },
      });
      expect(response).toEqual(expected);
      expect(JSON.stringify(response)).not.toContain(ROOT_PAGE_ID);
    }
  });

  it('never reflects stored failure text or unvalidated completed output', async () => {
    const failure = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: {
        getJob: async () => makeJob({
          status: 'failed',
          error_message: 'secret-provider-error',
          output: { rawError: 'secret-output-error' },
          completed_at: new Date('2026-08-24T12:01:00.000Z'),
        }),
      },
    });
    const corruptCompletion = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: {
        getJob: async () => makeJob({
          status: 'completed',
          output: {
            ...completedResult(),
            rawError: 'secret-completed-output',
          },
          completed_at: new Date('2026-08-24T12:01:00.000Z'),
        }),
      },
    });

    expect(failure.statusCode).toBe(200);
    expect(failure.payload).toMatchObject({
      status: 'failed',
      result: null,
    });
    expect(JSON.stringify(failure)).not.toContain('secret');
    expect(corruptCompletion.statusCode).toBe(404);
    expect(corruptCompletion.payload).toEqual({
      ok: false,
      error: {
        code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
        message: 'The partition synchronization was not found.',
      },
    });
    expect(JSON.stringify(corruptCompletion)).not.toContain('secret');
  });

  it('rejects every contradictory completed-result projection uniformly', async () => {
    const contradictoryResults: unknown[] = [
      completedResult({
        manifestStatus: 'blocked',
        manifestId: null,
      }),
      completedResult({ manifestId: null }),
      completedResult({ freshSnapshotId: null }),
      completedResult({ fullSourceScan: false }),
      completedResult({ pageCount: 513 }),
      completedResult({ chunkCount: 2_049 }),
      completedResult({ pageVersionReuseCount: 13 }),
      completedResult({ embeddedChunkCount: 32 }),
      completedResult({
        pageChanges: {
          added: 1,
          changed: 2,
          moved: 1,
          deleted: 0,
          unchanged: 7,
        },
      }),
      {
        ...completedResult({
          outcome: 'completed_with_errors',
          safeReasonCode: 'SYNC_FAILED',
          fullSourceScan: false,
          manifestStatus: 'not_attempted',
          manifestId: null,
          freshSnapshotId: null,
        }),
      },
    ];

    for (const output of contradictoryResults) {
      const response = await getBackstageNotionPartitionSyncOperationStatus({
        universeId: UNIVERSE_ID,
        syncId: SYNC_ID,
        actorKey: ACTOR_KEY,
        dependencies: {
          getJob: async () => makeJob({
            status: 'completed',
            output,
            completed_at: new Date('2026-08-24T12:01:00.000Z'),
          }),
        },
      });

      expect(response).toEqual({
        statusCode: 404,
        payload: {
          ok: false,
          error: {
            code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
            message: 'The partition synchronization was not found.',
          },
        },
      });
    }
  });

  it('rejects impossible active and terminal timestamp states uniformly', async () => {
    const malformedJobs: JobData[] = [
      makeJob({
        status: 'completed',
        output: completedResult(),
        completed_at: null as unknown as Date,
      }),
      makeJob({
        status: 'failed',
        completed_at: null as unknown as Date,
      }),
      makeJob({
        status: 'running',
        completed_at: new Date('2026-08-24T12:01:00.000Z'),
      }),
      makeJob({
        status: 'running',
        updated_at: new Date('2026-08-24T11:59:59.000Z'),
      }),
      makeJob({
        status: 'completed',
        output: completedResult(),
        completed_at: new Date('2026-08-24T11:59:59.000Z'),
      }),
      makeJob({
        status: 'completed',
        output: completedResult(),
        updated_at: new Date('2026-08-24T12:00:30.000Z'),
        completed_at: new Date('2026-08-24T12:01:00.000Z'),
      }),
    ];

    for (const job of malformedJobs) {
      const response = await getBackstageNotionPartitionSyncOperationStatus({
        universeId: UNIVERSE_ID,
        syncId: SYNC_ID,
        actorKey: ACTOR_KEY,
        dependencies: { getJob: async () => job },
      });
      expect(response.statusCode).toBe(404);
      expect(response.payload).toEqual({
        ok: false,
        error: {
          code: 'BACKSTAGE_NOTION_PARTITION_SYNC_NOT_FOUND',
          message: 'The partition synchronization was not found.',
        },
      });
    }
  });

  it('keeps status repository failures inside the closed availability contract', async () => {
    const unavailable = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: {
        getJob: async () => {
          throw new JobRepositoryUnavailableError('private-database-detail');
        },
      },
    });
    const unexpected = await getBackstageNotionPartitionSyncOperationStatus({
      universeId: UNIVERSE_ID,
      syncId: SYNC_ID,
      actorKey: ACTOR_KEY,
      dependencies: {
        getJob: async () => {
          throw new Error('unbounded-private-database-error');
        },
      },
    });

    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.retryAfterSeconds).toBe(30);
    expect(unexpected.statusCode).toBe(500);
    expect(JSON.stringify([unavailable, unexpected])).not.toContain('secret');
    expect(JSON.stringify([unavailable, unexpected])).not.toContain('unbounded-private');
  });
});
