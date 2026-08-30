import { describe, expect, it } from '@jest/globals';

import {
  evaluateBackstageNotionPartitionCutoverGate,
  type BackstageNotionPartitionCutoverGateEvidence,
  type BackstageNotionPartitionCutoverGateReasonCode,
} from '../src/shared/backstage/backstageNotionPartitionCutoverGate.js';
import { DEFAULT_OPENAI_EMBEDDING_MODEL } from
  '../src/services/openai/embeddings.js';

const UNIVERSE_ID = 'my-universe-2k26';
const CONFIGURATION_HASH = 'a'.repeat(64);
const MANIFEST_ID = '11111111-1111-4111-8111-111111111111';
const MONOLITH_SNAPSHOT_ID = '22222222-2222-4222-8222-222222222222';
const CONFIGURATION_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const SOURCE_GENERATION_ID = '44444444-4444-4444-8444-444444444444';
const RAW_SNAPSHOT_ID = '55555555-5555-4555-8555-555555555555';
const SHARED_SNAPSHOT_ID = '66666666-6666-4666-8666-666666666666';
const NOW = new Date('2026-08-29T12:00:00.000Z');
const CONFIGURED_SHARD_KEYS = Object.freeze(['raw', 'shared']);

function completeMember(overrides: Partial<
BackstageNotionPartitionCutoverGateEvidence['members'][number]
> = {}): BackstageNotionPartitionCutoverGateEvidence['members'][number] {
  return {
    shardKey: 'raw',
    snapshotId: RAW_SNAPSHOT_ID,
    sourceGenerationId: SOURCE_GENERATION_ID,
    indexFormatVersion: 1,
    pageCount: 3,
    chunkCount: 5,
    decision: 'fresh',
    readable: true,
    ...overrides,
  };
}

function completeEvidence(
  overrides: Partial<BackstageNotionPartitionCutoverGateEvidence> = {}
): BackstageNotionPartitionCutoverGateEvidence {
  return {
    evidenceVersion: 1,
    reconciliationGeneration: 7,
    activeReconciliationGeneration: 7,
    publishedReconciliationGeneration: 7,
    universeId: UNIVERSE_ID,
    manifestId: MANIFEST_ID,
    activeManifestId: MANIFEST_ID,
    manifestState: 'sealed',
    manifestReadable: true,
    manifestConfigurationVersionId: CONFIGURATION_VERSION_ID,
    activeConfigurationVersionId: CONFIGURATION_VERSION_ID,
    configurationHash: CONFIGURATION_HASH,
    activeConfigurationHash: CONFIGURATION_HASH,
    sourceGenerationId: SOURCE_GENERATION_ID,
    sourceDigest: 'b'.repeat(64),
    sourcePageCount: 6,
    sourceChunkCount: 10,
    sourceVerifiedAt: new Date('2026-08-29T10:59:00.000Z'),
    sourceVerificationHash: 'c'.repeat(64),
    manifestPageCount: 6,
    manifestChunkCount: 10,
    embeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    indexFormatVersion: 1,
    memberCount: 2,
    omissionCount: 0,
    members: [
      completeMember(),
      completeMember({
        shardKey: 'shared',
        snapshotId: SHARED_SNAPSHOT_ID,
      }),
    ],
    leaseFencingClear: true,
    unresolvedActivationCount: 0,
    parity: {
      shadowComparisonCompleted: true,
      exactScopeParityPassed: true,
      relevantRetrievalParityPassed: true,
      completeScopeParityPassed: true,
      cursorStabilityPassed: true,
    },
    rollbackMonolithSnapshotId: MONOLITH_SNAPSHOT_ID,
    rollbackMonolithReadable: true,
    rollbackMonolithChunkCount: 10,
    rollbackMonolithVerifiedAt: new Date('2026-08-29T10:58:00.000Z'),
    rollbackMonolithValidUntil: new Date('2026-08-29T13:00:00.000Z'),
    verifiedAt: new Date('2026-08-29T11:00:00.000Z'),
    expiresAt: new Date('2026-08-29T13:00:00.000Z'),
    ...overrides,
  };
}

function evaluate(
  evidence?: BackstageNotionPartitionCutoverGateEvidence | null,
  maximumStalenessMs = 24 * 60 * 60 * 1_000
) {
  return evaluateBackstageNotionPartitionCutoverGate({
    universeId: UNIVERSE_ID,
    configurationHash: CONFIGURATION_HASH,
    configuredShardKeys: CONFIGURED_SHARD_KEYS,
    maximumStalenessMs,
    supportedEmbeddingModel: DEFAULT_OPENAI_EMBEDDING_MODEL,
    evidence,
    now: NOW,
  });
}

describe('Backstage Notion partition cutover gate', () => {
  it('defaults closed without explicit evidence', () => {
    expect(evaluate()).toEqual({
      available: false,
      effectiveReadMode: 'monolith',
      manifestId: null,
      reasonCodes: ['CUTOVER_EVIDENCE_MISSING'],
    });
  });

  it('admits only one complete exact sealed generation', () => {
    expect(evaluate(completeEvidence())).toEqual({
      available: true,
      effectiveReadMode: 'partitioned',
      manifestId: MANIFEST_ID,
      reasonCodes: [],
    });
  });

  it('applies the serving freshness ceiling instead of the longer evidence window', () => {
    const fiveMinutesMs = 5 * 60 * 1_000;
    const staleRollback = completeEvidence({
      rollbackMonolithVerifiedAt: new Date(NOW.getTime() - fiveMinutesMs - 1),
      rollbackMonolithValidUntil: new Date(NOW.getTime() + 60 * 60 * 1_000),
      verifiedAt: new Date(NOW.getTime() - 1),
    });
    const freshRollback = completeEvidence({
      rollbackMonolithVerifiedAt: new Date(NOW.getTime() - fiveMinutesMs),
      rollbackMonolithValidUntil: new Date(NOW.getTime() + 60 * 60 * 1_000),
      verifiedAt: new Date(NOW.getTime() - 1),
    });

    expect(evaluate(staleRollback, fiveMinutesMs)).toMatchObject({
      available: false,
      effectiveReadMode: 'monolith',
      reasonCodes: ['CUTOVER_ROLLBACK_MONOLITH_UNAVAILABLE'],
    });
    expect(evaluate(freshRollback, fiveMinutesMs)).toEqual({
      available: true,
      effectiveReadMode: 'partitioned',
      manifestId: MANIFEST_ID,
      reasonCodes: [],
    });
  });

  const cases: readonly Readonly<{
    label: string;
    reason: BackstageNotionPartitionCutoverGateReasonCode;
    evidence: () => BackstageNotionPartitionCutoverGateEvidence;
  }>[] = [
    {
      label: 'evidence validity window',
      reason: 'CUTOVER_EVIDENCE_OUTSIDE_VALIDITY_WINDOW',
      evidence: () => completeEvidence({
        expiresAt: new Date('2026-08-29T11:59:59.999Z'),
      }),
    },
    {
      label: 'active manifest identity',
      reason: 'CUTOVER_MANIFEST_NOT_ACTIVE',
      evidence: () => completeEvidence({
        activeManifestId: '33333333-3333-4333-8333-333333333333',
      }),
    },
    {
      label: 'sealed manifest state',
      reason: 'CUTOVER_MANIFEST_NOT_SEALED',
      evidence: () => completeEvidence({ manifestState: 'building' }),
    },
    {
      label: 'readable manifest',
      reason: 'CUTOVER_MANIFEST_UNREADABLE',
      evidence: () => completeEvidence({ manifestReadable: false }),
    },
    {
      label: 'exact active configuration',
      reason: 'CUTOVER_CONFIGURATION_MISMATCH',
      evidence: () => completeEvidence({
        activeConfigurationHash: 'b'.repeat(64),
      }),
    },
    {
      label: 'exact active configuration version',
      reason: 'CUTOVER_CONFIGURATION_MISMATCH',
      evidence: () => completeEvidence({
        activeConfigurationVersionId:
          '44444444-4444-4444-8444-444444444444',
      }),
    },
    {
      label: 'exact published reconciliation generation',
      reason: 'CUTOVER_RECONCILIATION_GENERATION_MISMATCH',
      evidence: () => completeEvidence({
        publishedReconciliationGeneration: 6,
      }),
    },
    {
      label: 'complete configured shard set',
      reason: 'CUTOVER_SHARD_SET_INCOMPLETE',
      evidence: () => completeEvidence({
        memberCount: 1,
        members: [completeMember({ pageCount: 6, chunkCount: 10 })],
      }),
    },
    {
      label: 'one source generation across every shard',
      reason: 'CUTOVER_SOURCE_GENERATION_MISMATCH',
      evidence: () => completeEvidence({
        members: [
          completeMember(),
          completeMember({
            shardKey: 'shared',
            snapshotId: SHARED_SNAPSHOT_ID,
            sourceGenerationId: '77777777-7777-4777-8777-777777777777',
          }),
        ],
      }),
    },
    {
      label: 'source-to-manifest page coverage parity',
      reason: 'CUTOVER_SOURCE_COVERAGE_MISMATCH',
      evidence: () => completeEvidence({ sourcePageCount: 7 }),
    },
    {
      label: 'source-to-manifest chunk coverage parity',
      reason: 'CUTOVER_SOURCE_COVERAGE_MISMATCH',
      evidence: () => completeEvidence({ manifestChunkCount: 11 }),
    },
    {
      label: 'member-to-manifest aggregate coverage parity',
      reason: 'CUTOVER_SOURCE_COVERAGE_MISMATCH',
      evidence: () => completeEvidence({
        members: [
          completeMember({ chunkCount: 4 }),
          completeMember({
            shardKey: 'shared',
            snapshotId: SHARED_SNAPSHOT_ID,
          }),
        ],
      }),
    },
    {
      label: 'source verification no later than gate verification',
      reason: 'CUTOVER_SOURCE_VERIFICATION_INVALID',
      evidence: () => completeEvidence({
        sourceVerifiedAt: new Date('2026-08-29T11:00:00.001Z'),
      }),
    },
    {
      label: 'fresh shard decisions',
      reason: 'CUTOVER_SHARD_NOT_FRESH',
      evidence: () => completeEvidence({
        members: [
          completeMember(),
          completeMember({
            shardKey: 'shared',
            snapshotId: SHARED_SNAPSHOT_ID,
            decision: 'retained_last_known_good',
          }),
        ],
      }),
    },
    {
      label: 'readable shard members',
      reason: 'CUTOVER_SHARD_UNREADABLE',
      evidence: () => completeEvidence({
        members: [
          completeMember(),
          completeMember({
            shardKey: 'shared',
            snapshotId: SHARED_SNAPSHOT_ID,
            readable: false,
          }),
        ],
      }),
    },
    {
      label: 'zero omissions',
      reason: 'CUTOVER_OMISSIONS_PRESENT',
      evidence: () => completeEvidence({ omissionCount: 1 }),
    },
    {
      label: 'supported embedding model',
      reason: 'CUTOVER_EMBEDDING_MODEL_UNSUPPORTED',
      evidence: () => completeEvidence({
        embeddingModel: 'text-embedding-legacy',
      }),
    },
    {
      label: 'supported index format',
      reason: 'CUTOVER_INDEX_FORMAT_UNSUPPORTED',
      evidence: () => completeEvidence({ indexFormatVersion: 2 }),
    },
    {
      label: 'member index format matching its manifest',
      reason: 'CUTOVER_INDEX_FORMAT_UNSUPPORTED',
      evidence: () => completeEvidence({
        members: [
          completeMember(),
          completeMember({
            shardKey: 'shared',
            snapshotId: SHARED_SNAPSHOT_ID,
            indexFormatVersion: 2,
          }),
        ],
      }),
    },
    {
      label: 'lease fencing',
      reason: 'CUTOVER_LEASE_FENCING_UNRESOLVED',
      evidence: () => completeEvidence({ leaseFencingClear: false }),
    },
    {
      label: 'resolved activation transaction',
      reason: 'CUTOVER_ACTIVATION_UNRESOLVED',
      evidence: () => completeEvidence({ unresolvedActivationCount: 1 }),
    },
    {
      label: 'representative shadow comparison',
      reason: 'CUTOVER_SHADOW_COMPARISON_INCOMPLETE',
      evidence: () => completeEvidence({
        parity: {
          ...completeEvidence().parity,
          shadowComparisonCompleted: false,
        },
      }),
    },
    {
      label: 'exact-scope parity',
      reason: 'CUTOVER_EXACT_SCOPE_PARITY_FAILED',
      evidence: () => completeEvidence({
        parity: {
          ...completeEvidence().parity,
          exactScopeParityPassed: false,
        },
      }),
    },
    {
      label: 'bounded relevant parity',
      reason: 'CUTOVER_RELEVANT_RETRIEVAL_PARITY_FAILED',
      evidence: () => completeEvidence({
        parity: {
          ...completeEvidence().parity,
          relevantRetrievalParityPassed: false,
        },
      }),
    },
    {
      label: 'complete-scope parity',
      reason: 'CUTOVER_COMPLETE_SCOPE_PARITY_FAILED',
      evidence: () => completeEvidence({
        parity: {
          ...completeEvidence().parity,
          completeScopeParityPassed: false,
        },
      }),
    },
    {
      label: 'cursor stability',
      reason: 'CUTOVER_CURSOR_STABILITY_FAILED',
      evidence: () => completeEvidence({
        parity: {
          ...completeEvidence().parity,
          cursorStabilityPassed: false,
        },
      }),
    },
    {
      label: 'readable rollback monolith',
      reason: 'CUTOVER_ROLLBACK_MONOLITH_UNAVAILABLE',
      evidence: () => completeEvidence({
        rollbackMonolithReadable: false,
      }),
    },
    {
      label: 'nonzero rollback monolith coverage',
      reason: 'CUTOVER_ROLLBACK_MONOLITH_UNAVAILABLE',
      evidence: () => completeEvidence({
        rollbackMonolithChunkCount: 0,
      }),
    },
  ];

  it.each(cases)('keeps cutover closed without $label', ({ evidence, reason }) => {
    const result = evaluate(evidence());

    expect(result.available).toBe(false);
    expect(result.effectiveReadMode).toBe('monolith');
    expect(result.reasonCodes).toContain(reason);
  });

  it('rejects malformed or unbounded evidence without throwing', () => {
    const malformed = completeEvidence({ evidenceVersion: 2 });

    expect(evaluate(malformed)).toEqual({
      available: false,
      effectiveReadMode: 'monolith',
      manifestId: null,
      reasonCodes: ['CUTOVER_EVIDENCE_INVALID'],
    });
  });
});
