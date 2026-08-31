import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, jest, test } from '@jest/globals';

import {
  BackstageNotionPartitionRepositoryUnavailableError,
} from '../src/core/db/repositories/backstageNotionPartitionRepository.js';
import {
  WorkerAiCallBudgetPausedError,
} from '../src/core/adapters/openai.adapter.js';
import {
  BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
  BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS,
  parseBackstageNotionPartitionSyncJobResult,
} from '../src/shared/jobs/backstageNotionPartitionSyncJob.js';
import {
  resolveBackstageNotionPartitionShadowPolicy,
} from '../src/workers/backstageNotionPartitionShadowLoop.js';
import {
  createBackstageNotionPartitionSyncJobExecutor,
} from '../src/workers/backstageNotionPartitionSyncJob.js';
import type {
  BackstageNotionSynchronizationCoordinator,
} from '../src/workers/backstageNotionSyncLoop.js';

const UNIVERSE_ID = 'my-universe-2k26';
const SHARD_KEY = 'raw/2026';
const ROOT_PAGE_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const MANIFEST_ID = '33333333-3333-4333-8333-333333333333';
const CONFIGURATION_VERSION_ID = '44444444-4444-4444-8444-444444444444';
const CONFIGURATION_GENERATION = 'operator-generation-1';

const CONFIGURATION = JSON.stringify({
  version: 1,
  generation: CONFIGURATION_GENERATION,
  universes: [{
    universeId: UNIVERSE_ID,
    shards: [{
      shardKey: SHARD_KEY,
      rootPageId: ROOT_PAGE_ID,
      displayName: 'Monday Night Raw 2026',
      retrievalTier: 'hot',
      required: true,
      scopeTags: ['brand:raw', 'year:2026'],
      categoryTags: ['current-canon'],
      capacity: {
        maxPages: 512,
        maxChunks: 2_048,
        maxDepth: 16,
        maxContentCodePoints: 4_000_000,
      },
    }],
  }],
});

function environment(
  values: Readonly<Record<string, string | undefined>>
): (name: string) => string | undefined {
  return name => values[name];
}

function configuredEnvironment(): (name: string) => string | undefined {
  return environment({
    ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
    ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: CONFIGURATION,
  });
}

const CONFIGURATION_DIGEST = resolveBackstageNotionPartitionShadowPolicy(
  configuredEnvironment()
).semanticDigest!;

function jobInput(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    protocol: BACKSTAGE_NOTION_PARTITION_SYNC_JOB_PROTOCOL,
    version: 1,
    universeId: UNIVERSE_ID,
    shardKey: SHARD_KEY,
    configurationGeneration: CONFIGURATION_GENERATION,
    configurationDigest: CONFIGURATION_DIGEST,
    ...overrides,
  };
}

function immediateCoordinator(): BackstageNotionSynchronizationCoordinator {
  return {
    runExclusive: async operation => operation(),
  };
}

function synchronizationResult(input: {
  status?: 'fresh' | 'failed' | 'lease-busy' | 'aborted';
  safeReasonCode?: 'SHARD_CAPTURE_INCOMPLETE' | 'SHARD_LEASE_BUSY' | 'SHARD_ABORTED' | null;
  manifestStatus?: 'published' | 'blocked' | 'deferred';
  manifestOmissions?: readonly Readonly<{
    shardKey: string;
    safeReasonCode: string;
  }>[];
  fullSourceScan?: boolean;
} = {}) {
  const status = input.status ?? 'fresh';
  return {
    kind: 'targeted_reconciliation' as const,
    universes: [{
      universeId: UNIVERSE_ID,
      configurationVersionId: CONFIGURATION_VERSION_ID,
      manifestStatus: input.manifestStatus ?? 'published',
      manifestId: input.manifestStatus === 'blocked'
        || input.manifestStatus === 'deferred'
        ? null
        : MANIFEST_ID,
      memberCount: status === 'fresh' ? 1 : 0,
      omissionCount: input.manifestOmissions?.length
        ?? (status === 'fresh' ? 0 : 1),
      manifestOmissions: input.manifestOmissions ?? [],
      shardResults: [{
        universeId: UNIVERSE_ID,
        shardKey: SHARD_KEY,
        status,
        safeReasonCode: input.safeReasonCode ?? null,
        freshSnapshotId: status === 'fresh' ? SNAPSHOT_ID : null,
        fullSourceScan: input.fullSourceScan ?? status === 'fresh',
        pageCount: status === 'fresh' ? 2 : 0,
        chunkCount: status === 'fresh' ? 3 : 0,
        pageVersionReuseCount: status === 'fresh' ? 1 : 0,
        embeddedChunkCount: status === 'fresh' ? 1 : 0,
        leaseReleaseVerified: true,
        pageChanges: status === 'fresh'
          ? { added: 1, changed: 0, moved: 0, deleted: 0, unchanged: 1 }
          : { added: 0, changed: 0, moved: 0, deleted: 0, unchanged: 0 },
      }],
    }],
  };
}

describe('queued Backstage Notion partition synchronization execution', () => {
  test('rejects a malformed closed envelope before environment or coordinator work', async () => {
    const readEnvironment = jest.fn(configuredEnvironment());
    const runExclusive = jest.fn(async <T>(operation: () => Promise<T>) => operation());
    const runSynchronization = jest.fn(async () => synchronizationResult());
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: { runExclusive },
      readEnvironment,
      runSynchronization,
    });

    await expect(execute({
      rawInput: { ...jobInput(), unexpected: true },
      cancellationSignal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'failed',
      output: null,
      errorMessage: 'Invalid partition synchronization job input.',
      retryable: false,
    });
    expect(readEnvironment).not.toHaveBeenCalled();
    expect(runExclusive).not.toHaveBeenCalled();
    expect(runSynchronization).not.toHaveBeenCalled();
  });

  test.each(['monolith', 'partitioned'] as const)(
    're-reads live %s policy inside the coordinator before effectful synchronization',
    async liveMode => {
      const values: Record<string, string | undefined> = {
        ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
        ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: CONFIGURATION,
      };
      const runSynchronization = jest.fn(async () => synchronizationResult());
      const coordinator: BackstageNotionSynchronizationCoordinator = {
        runExclusive: async operation => {
          values.ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE = liveMode;
          return operation();
        },
      };
      const execute = createBackstageNotionPartitionSyncJobExecutor({
        coordinator,
        readEnvironment: environment(values),
        runSynchronization,
      });

      const outcome = await execute({
        rawInput: jobInput(),
        cancellationSignal: new AbortController().signal,
      });

      expect(outcome).toMatchObject({
        status: 'completed',
        retryable: false,
        output: {
          outcome: 'completed_with_errors',
          safeReasonCode: 'MODE_DISABLED',
          fullSourceScan: false,
          manifestStatus: 'not_attempted',
        },
      });
      expect(runSynchronization).not.toHaveBeenCalled();
    }
  );

  test.each([
    ['digest', jobInput({ configurationDigest: 'f'.repeat(64) })],
    ['generation', jobInput({ configurationGeneration: 'other-generation' })],
  ])('completes a stale %s request without consuming queue retries', async (_label, rawInput) => {
    const runSynchronization = jest.fn(async () => synchronizationResult());
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    const outcome = await execute({
      rawInput,
      cancellationSignal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      retryable: false,
      output: { safeReasonCode: 'CONFIGURATION_STALE' },
    });
    expect(runSynchronization).not.toHaveBeenCalled();
  });

  test('revalidates exact target membership before constructing sync effects', async () => {
    const otherConfiguration = JSON.stringify({
      ...(JSON.parse(CONFIGURATION) as Record<string, unknown>),
      universes: [{
        universeId: UNIVERSE_ID,
        shards: [{
          shardKey: 'archive/raw/2025',
          rootPageId: '55555555-5555-4555-8555-555555555555',
          displayName: 'Raw Archive 2025',
          retrievalTier: 'archive',
          required: false,
          scopeTags: ['brand:raw', 'year:2025'],
          categoryTags: ['archive'],
          capacity: {
            maxPages: 512,
            maxChunks: 2_048,
            maxDepth: 16,
            maxContentCodePoints: 4_000_000,
          },
        }],
      }],
    });
    const readEnvironment = environment({
      ARCANOS_BACKSTAGE_NOTION_PARTITIONED_INDEX_MODE: 'shadow',
      ARCANOS_BACKSTAGE_NOTION_PARTITIONS_JSON: otherConfiguration,
    });
    const digest = resolveBackstageNotionPartitionShadowPolicy(
      readEnvironment
    ).semanticDigest!;
    const runSynchronization = jest.fn(async () => synchronizationResult());
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment,
      runSynchronization,
    });

    await expect(execute({
      rawInput: jobInput({ configurationDigest: digest }),
      cancellationSignal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'completed',
      retryable: false,
      output: {
        safeReasonCode: 'TARGET_UNAVAILABLE',
        fullSourceScan: false,
      },
    });
    expect(runSynchronization).not.toHaveBeenCalled();
  });

  test('passes the exact stable selection and cancellation signal to the shared cycle', async () => {
    const controller = new AbortController();
    const runSynchronization = jest.fn(async () => synchronizationResult());
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    const outcome = await execute({
      rawInput: jobInput(),
      cancellationSignal: controller.signal,
    });

    expect(runSynchronization).toHaveBeenCalledWith(expect.objectContaining({
      signal: controller.signal,
      selection: { universeId: UNIVERSE_ID, shardKey: SHARD_KEY },
    }));
    expect(outcome).toMatchObject({
      status: 'completed',
      retryable: false,
      output: {
        outcome: 'synchronized',
        safeReasonCode: null,
        fullSourceScan: true,
        manifestStatus: 'published',
        pageCount: 2,
        chunkCount: 3,
        pageVersionReuseCount: 1,
        embeddedChunkCount: 1,
      },
    });
    expect(parseBackstageNotionPartitionSyncJobResult(outcome.output))
      .not.toBeNull();
  });

  test('never reports an ownership-omitted targeted shard as synchronized', async () => {
    const runSynchronization = jest.fn(async () => synchronizationResult({
      manifestOmissions: [{
        shardKey: SHARD_KEY,
        safeReasonCode: 'SHARD_OWNERSHIP_CONFLICT',
      }],
    }));
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    const outcome = await execute({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    });

    expect(outcome).toMatchObject({
      status: 'completed',
      retryable: false,
      output: {
        outcome: 'completed_with_errors',
        safeReasonCode: 'SHARD_OWNERSHIP_CONFLICT',
        fullSourceScan: true,
        manifestStatus: 'published',
        manifestId: MANIFEST_ID,
        freshSnapshotId: SNAPSHOT_ID,
      },
    });
  });

  test('persists expected shard and manifest failures as bounded completed results', async () => {
    const failedShard = jest.fn(async () => synchronizationResult({
      status: 'failed',
      safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
      manifestStatus: 'blocked',
    }));
    const executeFailedShard = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization: failedShard,
    });

    await expect(executeFailedShard({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'completed',
      retryable: false,
      output: {
        outcome: 'completed_with_errors',
        safeReasonCode: 'SHARD_CAPTURE_INCOMPLETE',
        fullSourceScan: false,
        manifestStatus: 'blocked',
      },
    });

    const blockedManifest = jest.fn(async () => synchronizationResult({
      manifestStatus: 'blocked',
    }));
    const executeBlockedManifest = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization: blockedManifest,
    });
    await expect(executeBlockedManifest({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    })).resolves.toMatchObject({
      status: 'completed',
      retryable: false,
      output: { safeReasonCode: 'MANIFEST_BLOCKED' },
    });
  });

  test('allows one queue retry only for classified transient infrastructure', async () => {
    const runSynchronization = jest.fn(async () => {
      throw new BackstageNotionPartitionRepositoryUnavailableError();
    });
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    await expect(execute({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    })).resolves.toEqual({
      status: 'failed',
      output: null,
      errorMessage:
        'Partition synchronization infrastructure is temporarily unavailable.',
      retryable: true,
    });
  });

  test('preserves a worker AI budget pause for job-level deferral', async () => {
    const budgetError = new WorkerAiCallBudgetPausedError(
      '2026-08-30T15:00:00.000Z'
    );
    const runSynchronization = jest.fn(async () => {
      throw budgetError;
    });
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    await expect(execute({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    })).rejects.toBe(budgetError);
  });

  test('redacts unexpected failures and treats them as terminal', async () => {
    const privateFailure = `provider body ${ROOT_PAGE_ID}`;
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization: async () => {
        throw new Error(privateFailure);
      },
    });

    const outcome = await execute({
      rawInput: jobInput(),
      cancellationSignal: new AbortController().signal,
    });

    expect(outcome).toEqual({
      status: 'failed',
      output: null,
      errorMessage: 'Partition synchronization execution failed.',
      retryable: false,
    });
    expect(JSON.stringify(outcome)).not.toContain(privateFailure);
    expect(JSON.stringify(outcome)).not.toContain(ROOT_PAGE_ID);
  });

  test('returns a bounded cancellation without starting a provider cycle', async () => {
    const controller = new AbortController();
    controller.abort(new Error(`private cancellation ${ROOT_PAGE_ID}`));
    const runSynchronization = jest.fn(async () => synchronizationResult());
    const execute = createBackstageNotionPartitionSyncJobExecutor({
      coordinator: immediateCoordinator(),
      readEnvironment: configuredEnvironment(),
      runSynchronization,
    });

    const outcome = await execute({
      rawInput: jobInput(),
      cancellationSignal: controller.signal,
    });

    expect(outcome).toEqual({
      status: 'cancelled',
      output: null,
      errorMessage: 'Partition synchronization cancellation requested.',
      retryable: false,
    });
    expect(runSynchronization).not.toHaveBeenCalled();
    expect(JSON.stringify(outcome)).not.toContain(ROOT_PAGE_ID);
  });
});

describe('partition synchronization job-runner dispatch boundary', () => {
  test('dispatches before generic provider preflight with the 512-call embedding budget', () => {
    const source = fs
      .readFileSync(path.resolve('src/workers/jobRunner.ts'), 'utf8')
      .replace(/\r\n/gu, '\n');
    const dedicatedDispatchIndex = source.indexOf(
      'if (job.job_type === BACKSTAGE_NOTION_PARTITION_SYNC_JOB_TYPE) {'
    );
    const dedicatedExecutorIndex = source.indexOf(
      'partitionSyncExecutor({',
      dedicatedDispatchIndex
    );
    const providerPreflightIndex = source.indexOf(
      'const ensuredClientState = await ensureOpenAIClientForSlot({',
      dedicatedDispatchIndex
    );
    const dedicatedSlice = source.slice(
      dedicatedDispatchIndex,
      providerPreflightIndex
    );

    expect(BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS).toBe(512);
    expect(dedicatedDispatchIndex).toBeGreaterThan(-1);
    expect(dedicatedExecutorIndex).toBeGreaterThan(dedicatedDispatchIndex);
    expect(providerPreflightIndex).toBeGreaterThan(dedicatedExecutorIndex);
    expect(dedicatedSlice).toContain(
      'maxCalls: BACKSTAGE_NOTION_PARTITION_SYNC_MAX_AI_CALLS'
    );
  });
});
