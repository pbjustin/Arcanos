import { createHash } from 'node:crypto';

import { describe, expect, it, jest } from '@jest/globals';

import {
  BackstageNotionPartitionCutoverValidationError,
  validateAndSealBackstageNotionPartitionCutover,
  type BackstageNotionPartitionCutoverValidationAnchor,
  type BackstageNotionPartitionCutoverValidationCase,
  type BackstageNotionPartitionCutoverValidationDependencies,
} from '../src/services/backstageNotionPartitionCutoverValidation.js';
import type {
  BackstageNotionPartitionRagRetrieval,
  BackstageNotionPartitionRetrievalPlan,
} from '../src/services/backstageNotionPartitionRetrieval.js';
import type {
  BackstageNotionRagCitation,
  BackstageNotionRagCoverage,
  BackstageNotionRagQuery,
  BackstageNotionRagRetrieval,
  BackstageNotionRagRetrievalMode,
} from '../src/services/backstageNotionRag.js';

const UNIVERSE_ID = 'my-universe-2k26';
const MONOLITH_SNAPSHOT_ID = '11111111-1111-4111-8111-111111111111';
const PARTITION_MANIFEST_ID = '22222222-2222-4222-8222-222222222222';
const CONFIGURATION_VERSION_ID = '33333333-3333-4333-8333-333333333333';
const CONFIGURATION_GENERATION = 'generation-7';
const SOURCE_GENERATION_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_MANIFEST_ID = '55555555-5555-4555-8555-555555555555';
const VERIFIED_AT = new Date('2026-08-30T12:00:00.000Z');
const ROLLBACK_MONOLITH_VALID_UNTIL = new Date(
  VERIFIED_AT.getTime() + 24 * 60 * 60 * 1_000
);

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const ANCHOR: BackstageNotionPartitionCutoverValidationAnchor = Object.freeze({
  universeId: UNIVERSE_ID,
  monolithSnapshotId: MONOLITH_SNAPSHOT_ID,
  partitionManifestId: PARTITION_MANIFEST_ID,
  partitionConfigurationVersionId: CONFIGURATION_VERSION_ID,
  partitionConfigurationGeneration: CONFIGURATION_GENERATION,
  partitionConfigurationHash: hash('configuration'),
  partitionSourceGenerationId: SOURCE_GENERATION_ID,
  partitionSourceDigest: hash('source'),
  partitionSourceVerificationHash: hash('source-verification'),
  reconciliationGeneration: 7,
  rollbackMonolithVerifiedAt: new Date(VERIFIED_AT),
  rollbackMonolithValidUntil: new Date(ROLLBACK_MONOLITH_VALID_UNTIL),
});

const EXACT_QUERY: BackstageNotionRagQuery = Object.freeze({
  query: 'PRIVATE exact representative query',
  retrievalMode: 'relevant' as const,
  retrievalScope: Object.freeze({
    pageTitle: 'Synthetic Raw authority',
    scopeKind: 'page' as const,
  }),
});
const RELEVANT_QUERY = 'PRIVATE relevant representative query';
const COMPLETE_QUERY: BackstageNotionRagQuery = Object.freeze({
  query: 'PRIVATE complete representative query',
  retrievalMode: 'complete_scope' as const,
  retrievalScope: Object.freeze({
    pageTitle: 'Synthetic audit authority',
    scopeKind: 'subtree' as const,
  }),
});

const CASES: readonly BackstageNotionPartitionCutoverValidationCase[] = Object.freeze([
  Object.freeze({ caseId: 'exact-raw', kind: 'exact_scope', query: EXACT_QUERY }),
  Object.freeze({ caseId: 'relevant-raw', kind: 'relevant', query: RELEVANT_QUERY }),
  Object.freeze({ caseId: 'complete-audit', kind: 'complete_scope', query: COMPLETE_QUERY }),
]);

function queryText(query: BackstageNotionRagQuery): string {
  return typeof query === 'string' ? query : query.query;
}

function citation(label: string): BackstageNotionRagCitation {
  return {
    pageId: `${label.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-000000000000`,
    pageTitle: `PRIVATE page ${label}`,
    pagePath: ['PRIVATE synthetic authority'],
    headingPath: ['PRIVATE heading'],
    category: 'raw',
    chunkId: hash(`chunk:${label}`),
    contentHash: hash(`content:${label}`),
  };
}

const CITATION_A = citation('a');
const CITATION_B = citation('b');
const CITATION_C = citation('c');

function coverage(input: {
  scopeChunks: number;
  selectedChunks: number;
  nextCursor: string | null;
}): BackstageNotionRagCoverage {
  return {
    status: input.nextCursor === null && input.selectedChunks === input.scopeChunks
      ? 'complete'
      : 'sampled',
    scopeChunks: input.scopeChunks,
    selectedChunks: input.selectedChunks,
    omittedChunks: input.scopeChunks - input.selectedChunks,
    promptTruncated: false,
    exhaustive: input.nextCursor === null && input.selectedChunks === input.scopeChunks,
    hasMore: input.nextCursor !== null,
    ...(input.nextCursor ? { nextCursor: input.nextCursor } : {}),
  };
}

function monolithRetrieval(input: {
  query: BackstageNotionRagQuery;
  citations: readonly BackstageNotionRagCitation[];
  mode?: BackstageNotionRagRetrievalMode;
  scopeChunks?: number;
  nextCursor?: string | null;
}): BackstageNotionRagRetrieval {
  const nextCursor = input.nextCursor ?? null;
  const scopeChunks = input.scopeChunks ?? input.citations.length;
  return {
    universeId: UNIVERSE_ID,
    snapshotId: MONOLITH_SNAPSHOT_ID,
    verifiedAt: new Date(VERIFIED_AT),
    snapshotStatus: 'current_complete',
    activeSnapshotVerifiedAt: new Date(VERIFIED_AT),
    activeSnapshotChunkCount: scopeChunks,
    latestSyncOutcome: 'unchanged',
    latestSyncFailurePhase: null,
    latestSyncFailureReason: null,
    prompt: `PRIVATE monolith prompt:${queryText(input.query)}:${nextCursor ?? 'terminal'}`,
    chunkCount: input.citations.length,
    truncated: scopeChunks > input.citations.length,
    retrievalMode: input.mode ?? 'relevant',
    resolvedScope: null,
    coverage: coverage({
      scopeChunks,
      selectedChunks: input.citations.length,
      nextCursor,
    }),
    nextCursor,
    citations: input.citations.map(item => ({ ...item })),
  };
}

function partitionRetrieval(input: {
  query: BackstageNotionRagQuery;
  citations: readonly BackstageNotionRagCitation[];
  mode?: BackstageNotionRagRetrievalMode;
  scopeChunks?: number;
  nextCursor?: string | null;
  manifestId?: string;
  promptSide?: 'monolith' | 'partition';
}): BackstageNotionPartitionRagRetrieval {
  const nextCursor = input.nextCursor ?? null;
  const scopeChunks = input.scopeChunks ?? input.citations.length;
  const promptSide = input.promptSide ?? 'partition';
  return {
    universeId: UNIVERSE_ID,
    manifestId: input.manifestId ?? PARTITION_MANIFEST_ID,
    configurationVersionId: CONFIGURATION_VERSION_ID,
    configurationHash: ANCHOR.partitionConfigurationHash,
    configurationCurrent: true,
    selectionDigest: hash('selection'),
    routingComplete: true,
    selectedShards: [],
    matchingOmissions: [],
    verifiedAt: new Date(VERIFIED_AT),
    prompt: `PRIVATE ${promptSide} prompt:${queryText(input.query)}:${nextCursor ?? 'terminal'}`,
    chunkCount: input.citations.length,
    truncated: scopeChunks > input.citations.length,
    retrievalMode: input.mode ?? 'relevant',
    resolvedScope: null,
    coverage: coverage({
      scopeChunks,
      selectedChunks: input.citations.length,
      nextCursor,
    }),
    nextCursor,
    citations: input.citations.map(item => ({
      ...item,
      shardKey: 'raw/year-2026',
      partitionVersionId: '66666666-6666-4666-8666-666666666666',
      snapshotId: '77777777-7777-4777-8777-777777777777',
      pageVersionId: hash(`page-version:${item.chunkId}`),
      chunkVersionId: hash(`chunk-version:${item.chunkId}`),
      canonicalUrl: 'https://www.notion.so/synthetic',
      sourceLastEditedAt: VERIFIED_AT.toISOString(),
    })),
  };
}

interface FixtureOptions {
  readonly relevantMismatch?: boolean;
  readonly cursorLoop?: boolean;
  readonly partitionVersionDrift?: boolean;
  readonly completeOmission?: boolean;
  readonly mismatchedPlannedRequest?: boolean;
  readonly terminalAnchorChanged?: boolean;
  readonly now?: Date;
}

function createFixtureDependencies(options: FixtureOptions = {}): Readonly<{
  dependencies: BackstageNotionPartitionCutoverValidationDependencies;
  sealEvidence: jest.MockedFunction<
    BackstageNotionPartitionCutoverValidationDependencies['sealEvidence']
  >;
  loadAnchor: jest.MockedFunction<
    BackstageNotionPartitionCutoverValidationDependencies['loadAnchor']
  >;
  events: string[];
}> {
  const events: string[] = [];
  let anchorReadCount = 0;
  const loadAnchor = jest.fn(async () => {
    anchorReadCount += 1;
    events.push(`anchor:${anchorReadCount}`);
    return options.terminalAnchorChanged && anchorReadCount > 1
      ? { ...ANCHOR, partitionManifestId: OTHER_MANIFEST_ID }
      : ANCHOR;
  });
  const derivePartitionPlan = jest.fn(async ({ query }: {
    universeId: string;
    manifestId: string;
    query: BackstageNotionRagQuery;
  }): Promise<BackstageNotionPartitionRetrievalPlan> => {
    events.push(`plan:${queryText(query)}`);
    const plannedQuery = options.mismatchedPlannedRequest
      && queryText(query) === RELEVANT_QUERY
      ? 'DIFFERENT request'
      : query;
    if (typeof plannedQuery === 'string') {
      return Object.freeze({
        query: plannedQuery,
        relevantRoutingIntent: Object.freeze({
          kind: 'relevant' as const,
          cardinality: 'all_matching' as const,
          allowedTiers: Object.freeze(['hot' as const, 'cold' as const]),
          explicitArchive: false,
          selectors: Object.freeze([Object.freeze({
            allScopeTags: Object.freeze(['brand:raw']),
            allCategoryTags: Object.freeze([]),
          })]),
        }),
      });
    }
    return Object.freeze({ query: plannedQuery });
  });
  const retrieveMonolithPinned = jest.fn(async (input: {
    universeId: string;
    snapshotId: string;
    query: BackstageNotionRagQuery;
    cursor: string | null;
  }): Promise<BackstageNotionRagRetrieval> => {
    const text = queryText(input.query);
    events.push(`monolith:${text}:${input.cursor ?? 'initial'}`);
    if (text === COMPLETE_QUERY.query) {
      if (input.cursor === null) {
        return monolithRetrieval({
          query: input.query,
          citations: [CITATION_A, CITATION_B],
          mode: 'complete_scope',
          scopeChunks: options.completeOmission ? 4 : 3,
          nextCursor: 'monolith-next',
        });
      }
      if (options.cursorLoop) {
        return monolithRetrieval({
          query: input.query,
          citations: [CITATION_C],
          mode: 'complete_scope',
          scopeChunks: 3,
          nextCursor: 'monolith-next',
        });
      }
      return monolithRetrieval({
        query: input.query,
        citations: [CITATION_C],
        mode: 'complete_scope',
        scopeChunks: options.completeOmission ? 4 : 3,
      });
    }
    const selected = text === RELEVANT_QUERY ? CITATION_B : CITATION_A;
    return monolithRetrieval({
      query: input.query,
      citations: [selected],
    });
  });
  const retrievePartitionPinned = jest.fn(async (input: {
    universeId: string;
    manifestId: string;
    plan: BackstageNotionPartitionRetrievalPlan;
    cursor: string | null;
  }): Promise<BackstageNotionPartitionRagRetrieval> => {
    const text = queryText(input.plan.query);
    events.push(`partition:${text}:${input.cursor ?? 'initial'}`);
    if (text === COMPLETE_QUERY.query) {
      if (input.cursor === null) {
        return partitionRetrieval({
          query: input.plan.query,
          citations: [CITATION_C],
          mode: 'complete_scope',
          scopeChunks: 3,
          nextCursor: 'partition-next',
        });
      }
      return partitionRetrieval({
        query: input.plan.query,
        citations: [CITATION_B, CITATION_A],
        mode: 'complete_scope',
        scopeChunks: 3,
        manifestId: options.partitionVersionDrift
          ? OTHER_MANIFEST_ID
          : PARTITION_MANIFEST_ID,
      });
    }
    const selected = text === RELEVANT_QUERY
      ? {
          ...CITATION_B,
          ...(options.relevantMismatch ? { contentHash: hash('mismatch') } : {}),
        }
      : CITATION_A;
    return partitionRetrieval({
      query: input.plan.query,
      citations: [selected],
      promptSide: 'monolith',
    });
  });
  const sealEvidence = jest.fn(async () => {
    events.push('seal');
  });
  return Object.freeze({
    dependencies: {
      loadAnchor,
      derivePartitionPlan,
      retrieveMonolithPinned,
      retrievePartitionPinned,
      sealEvidence,
      now: () => new Date(options.now ?? VERIFIED_AT),
    },
    sealEvidence,
    loadAnchor,
    events,
  });
}

function expectCode(code: BackstageNotionPartitionCutoverValidationError['code']) {
  return expect.objectContaining({ code });
}

describe('backstage Notion partition cutover validation producer', () => {
  it('seals content-free deterministic evidence after equal full coverage with different page and order layouts', async () => {
    const first = createFixtureDependencies();
    const firstResult = await validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: first.dependencies,
    });
    const second = createFixtureDependencies({
      now: new Date('2026-08-30T13:00:00.000Z'),
    });
    const secondResult = await validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: Object.freeze([...CASES].reverse()),
      dependencies: second.dependencies,
    });

    expect(firstResult).toMatchObject({
      caseCount: 3,
      exactScopeCaseCount: 1,
      relevantCaseCount: 1,
      completeScopeCaseCount: 1,
      cursorContinuationCaseCount: 1,
      monolithRequestCount: 4,
      partitionRequestCount: 4,
      citationCount: 5,
      exactScopeParityPassed: true,
      relevantRetrievalParityPassed: true,
      completeScopeParityPassed: true,
      cursorStabilityPassed: true,
      rollbackMonolithVerifiedAt: VERIFIED_AT,
      rollbackMonolithValidUntil: ROLLBACK_MONOLITH_VALID_UNTIL,
      partitionConfigurationGeneration: CONFIGURATION_GENERATION,
    });
    expect(firstResult.attestationDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(secondResult.attestationDigest).toBe(firstResult.attestationDigest);
    expect(firstResult.cases.map(item => item.caseId)).toEqual([
      'complete-audit',
      'exact-raw',
      'relevant-raw',
    ]);
    expect(first.loadAnchor).toHaveBeenCalledTimes(2);
    expect(first.sealEvidence).toHaveBeenCalledTimes(1);
    expect(first.sealEvidence).toHaveBeenCalledWith(firstResult);
    expect(first.sealEvidence).toHaveBeenCalledWith(expect.objectContaining({
      rollbackMonolithVerifiedAt: VERIFIED_AT,
      rollbackMonolithValidUntil: ROLLBACK_MONOLITH_VALID_UNTIL,
    }));
    expect(first.events.slice(-2)).toEqual(['anchor:2', 'seal']);
    const serialized = JSON.stringify(firstResult);
    expect(serialized).not.toContain('PRIVATE');
    expect(serialized).not.toContain('monolith-next');
    expect(serialized).not.toContain('partition-next');
  });

  it('fails closed without sealing when relevant comparison semantics mismatch', async () => {
    const fixture = createFixtureDependencies({ relevantMismatch: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_PARITY_MISMATCH'
    ));
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('fails closed without sealing when a complete-scope cursor loops', async () => {
    const fixture = createFixtureDependencies({ cursorLoop: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_CURSOR_INVALID'
    ));
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('fails closed without sealing when continuation crosses manifests', async () => {
    const fixture = createFixtureDependencies({ partitionVersionDrift: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_VERSION_DRIFT'
    ));
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('fails before reading an anchor when a required case category is missing', async () => {
    const fixture = createFixtureDependencies();
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES.filter(item => item.kind !== 'exact_scope'),
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID'
    ));
    expect(fixture.loadAnchor).not.toHaveBeenCalled();
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('rejects a scoped relevant case before it can satisfy relevant-routing coverage', async () => {
    const fixture = createFixtureDependencies();
    const scopedRelevantCases: readonly BackstageNotionPartitionCutoverValidationCase[] =
      Object.freeze(CASES.map(item => item.kind === 'relevant'
        ? Object.freeze({ ...item, query: EXACT_QUERY })
        : item));
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: scopedRelevantCases,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID'
    ));
    expect(fixture.loadAnchor).not.toHaveBeenCalled();
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('rejects a planner request that does not bind to the canonical case request', async () => {
    const fixture = createFixtureDependencies({ mismatchedPlannedRequest: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID'
    ));
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('rejects caller-supplied hand-picked partition routing', async () => {
    const fixture = createFixtureDependencies();
    const hostileCases = CASES.map(item => item.kind === 'relevant'
      ? {
          ...item,
          partitionPlan: {
            query: item.query,
            relevantRoutingIntent: {
              kind: 'relevant',
              cardinality: 'exactly_one',
              allowedTiers: ['hot'],
              explicitArchive: false,
              selectors: [{ allScopeTags: ['unrelated'], allCategoryTags: [] }],
            },
          },
        }
      : item) as unknown as readonly BackstageNotionPartitionCutoverValidationCase[];
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: hostileCases,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_INPUT_INVALID'
    ));
    expect(fixture.loadAnchor).not.toHaveBeenCalled();
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('rejects terminal omission even when every returned citation is unique', async () => {
    const fixture = createFixtureDependencies({ completeOmission: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_COVERAGE_INCOMPLETE'
    ));
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });

  it('reloads the anchor and refuses to seal evidence after an authority change', async () => {
    const fixture = createFixtureDependencies({ terminalAnchorChanged: true });
    await expect(validateAndSealBackstageNotionPartitionCutover({
      universeId: UNIVERSE_ID,
      cases: CASES,
      dependencies: fixture.dependencies,
    })).rejects.toEqual(expectCode(
      'BACKSTAGE_NOTION_PARTITION_CUTOVER_VALIDATION_ANCHOR_CHANGED'
    ));
    expect(fixture.loadAnchor).toHaveBeenCalledTimes(2);
    expect(fixture.sealEvidence).not.toHaveBeenCalled();
  });
});
