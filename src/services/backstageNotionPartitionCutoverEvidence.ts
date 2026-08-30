import { randomBytes } from 'node:crypto';

import {
  getBackstageNotionPartitionCutoverEvidenceRepository,
  getBackstageNotionPartitionRepository,
  getBackstageNotionRagRepository,
  getBackstageNotionSyncStatusRepository,
  type BackstageNotionPartitionCutoverEvidenceRepository,
  type BackstageNotionRagRepository,
  type BackstageNotionSyncStatusRepository,
} from '@core/db/index.js';
import type {
  PostgresBackstageNotionPartitionRepository,
} from '@core/db/repositories/backstageNotionPartitionRepository.js';
import type {
  BackstageNotionActiveSnapshotHeader,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import { getEnvNumber } from '@platform/runtime/env.js';
import type {
  BackstageNotionPartitionCutoverGateEvidence,
} from '@shared/backstage/backstageNotionPartitionCutoverGate.js';
import type {
  BackstageNotionPartitionConfiguration,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS,
  BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME,
  boundBackstageNotionRagMaximumStalenessMs,
  resolveBackstageNotionSnapshotStatus,
} from '@shared/backstage/backstageNotionSnapshotStatus.js';
import {
  deriveBackstageNotionPartitionCutoverValidationPlan,
} from './backstageNotionPartitionCutover.js';
import {
  runWithBackstageNotionEnrichmentAuthorization,
} from './backstageNotionEnrichmentAuthorization.js';
import type {
  BackstageNotionAuthorityRoot,
} from './backstageNotionAuthority.js';
import {
  retrieveBackstageNotionPartitionRagContext,
  type BackstageNotionPartitionRetrievalPlan,
} from './backstageNotionPartitionRetrieval.js';
import {
  resolveBackstageNotionPartitionPinnedRequest,
  resolveBackstageNotionPartitionPinnedScopeRequest,
} from './backstageNotionPartitionRouting.js';
import {
  retrieveBackstageNotionRagContext,
  type BackstageNotionRagQuery,
} from './backstageNotionRag.js';
import {
  validateAndSealBackstageNotionPartitionCutover,
  type BackstageNotionPartitionCutoverValidationAnchor,
  type BackstageNotionPartitionCutoverValidationAttestation,
  type BackstageNotionPartitionCutoverValidationCase,
  type BackstageNotionPartitionCutoverValidationDependencies,
} from './backstageNotionPartitionCutoverValidation.js';
import { createEmbedding } from './openai/embeddings.js';

type ValidPartitionConfiguration = Extract<
  BackstageNotionPartitionConfiguration,
  { status: 'valid' }
>;

interface ValidationRuntimeCache {
  readonly anchor: BackstageNotionPartitionCutoverValidationAnchor;
  readonly monolith: BackstageNotionActiveSnapshotHeader;
}

export interface BackstageNotionPartitionCutoverValidationRuntimeOverrides {
  readonly evidenceRepository?: BackstageNotionPartitionCutoverEvidenceRepository;
  readonly monolithRepository?: BackstageNotionRagRepository;
  readonly partitionRepository?: PostgresBackstageNotionPartitionRepository;
  readonly syncStatusRepository?: BackstageNotionSyncStatusRepository;
  readonly resolveAuthorityRoot?: (
    universeId: string
  ) => BackstageNotionAuthorityRoot | null
    | Promise<BackstageNotionAuthorityRoot | null>;
  readonly embedQuery?: (query: string) => Promise<number[]>;
  readonly maximumStalenessMs?: number;
  readonly now?: () => Date;
}

function withCursor(
  query: BackstageNotionRagQuery,
  cursor: string | null
): BackstageNotionRagQuery {
  if (cursor === null) {
    return query;
  }
  if (
    typeof query !== 'object'
    || query === null
    || Array.isArray(query)
    || Object.hasOwn(query, 'cursor')
  ) {
    throw new TypeError('A cutover validation cursor cannot alter this request.');
  }
  return Object.freeze({ ...query, cursor });
}

function bindEmbedding(
  embedQuery: (query: string) => Promise<number[]>
): (query: string) => Promise<number[]> {
  const cache = new Map<string, Promise<number[]>>();
  return query => {
    let result = cache.get(query);
    if (!result) {
      result = Promise.resolve().then(() => embedQuery(query));
      cache.set(query, result);
    }
    return result;
  };
}

function resolveCurrentMaximumStalenessMs(value?: number): number {
  return boundBackstageNotionRagMaximumStalenessMs(value ?? getEnvNumber(
    BACKSTAGE_NOTION_RAG_MAX_STALENESS_ENV_NAME,
    BACKSTAGE_NOTION_RAG_MAX_STALENESS_DEFAULT_MS
  ));
}

/**
 * Load only durable evidence still bound to the exact active configuration and
 * manifest. Every repository/schema failure is represented as missing evidence
 * so requested partition mode remains monolith-authoritative.
 */
export async function loadBackstageNotionPartitionCutoverGateEvidence(input: {
  readonly universeId: string;
  readonly configurationHash: string;
  readonly configuredShardKeys: readonly string[];
  readonly maximumStalenessMs?: number;
  readonly repository?: BackstageNotionPartitionCutoverEvidenceRepository;
}): Promise<BackstageNotionPartitionCutoverGateEvidence | null> {
  try {
    const repository = input.repository
      ?? getBackstageNotionPartitionCutoverEvidenceRepository();
    return await repository.loadGateEvidence({
      universeId: input.universeId,
      configurationHash: input.configurationHash,
      configuredShardKeys: input.configuredShardKeys,
      maximumStalenessMs: resolveCurrentMaximumStalenessMs(
        input.maximumStalenessMs
      ),
    });
  } catch {
    return null;
  }
}

/** Load one content-free evidence record per configured universe for worker boot. */
export async function loadBackstageNotionPartitionCutoverGateEvidenceSet(
  configuration: ValidPartitionConfiguration,
  repository?: BackstageNotionPartitionCutoverEvidenceRepository,
  maximumStalenessMs?: number
): Promise<readonly BackstageNotionPartitionCutoverGateEvidence[]> {
  const evidence = await Promise.all(configuration.universes.map(universe => (
    loadBackstageNotionPartitionCutoverGateEvidence({
      universeId: universe.universeId,
      configurationHash: configuration.semanticDigest,
      configuredShardKeys: universe.shards.map(shard => shard.shardKey),
      maximumStalenessMs,
      ...(repository ? { repository } : {}),
    })
  )));
  return Object.freeze(evidence.filter(
    (item): item is BackstageNotionPartitionCutoverGateEvidence => item !== null
  ));
}

/**
 * Create the dormant, explicitly invoked runtime adapters for representative
 * cutover validation. No scheduler, route, startup hook, or mode change calls
 * this factory. Its only write is the final evidence seal after all pinned
 * comparisons and the terminal anchor reload have passed.
 */
export function createBackstageNotionPartitionCutoverValidationDependencies(
  overrides: BackstageNotionPartitionCutoverValidationRuntimeOverrides = {}
): BackstageNotionPartitionCutoverValidationDependencies {
  const evidenceRepository = overrides.evidenceRepository
    ?? getBackstageNotionPartitionCutoverEvidenceRepository();
  const monolithRepository = overrides.monolithRepository
    ?? getBackstageNotionRagRepository();
  const partitionRepository = overrides.partitionRepository
    ?? getBackstageNotionPartitionRepository();
  const syncStatusRepository = overrides.syncStatusRepository
    ?? getBackstageNotionSyncStatusRepository();
  const maximumStalenessMs = resolveCurrentMaximumStalenessMs(
    overrides.maximumStalenessMs
  );
  const sharedEmbedding = bindEmbedding(overrides.embedQuery ?? createEmbedding);
  const cursorSecret = randomBytes(32).toString('base64url');
  const cache = new Map<string, ValidationRuntimeCache>();

  const requireCache = (
    universeId: string,
    monolithSnapshotId: string,
    partitionManifestId?: string
  ): ValidationRuntimeCache => {
    const cached = cache.get(universeId);
    if (
      !cached
      || cached.anchor.monolithSnapshotId !== monolithSnapshotId
      || (
        partitionManifestId !== undefined
        && cached.anchor.partitionManifestId !== partitionManifestId
      )
    ) {
      throw new Error('The cutover validation runtime lost its pinned anchor.');
    }
    return cached;
  };

  return Object.freeze({
    loadAnchor: async (universeId: string) => {
      const [anchor, monolith, partition, latestSyncAttempt] = await Promise.all([
        evidenceRepository.loadValidationAnchor(universeId),
        monolithRepository.loadActiveSnapshotHeader(universeId),
        partitionRepository.loadActiveManifestRoutingState(universeId),
        syncStatusRepository.loadLatestSyncAttempt(universeId),
      ]);
      const observedAt = overrides.now?.() ?? new Date();
      const status = monolith === null
        ? null
        : resolveBackstageNotionSnapshotStatus({
            activeSnapshotId: monolith.snapshot.id,
            activeSnapshotReadable: true,
            activeSnapshotVerifiedAt: monolith.verifiedAt,
            now: observedAt,
            maximumStalenessMs,
            latestSyncAttempt,
          });
      if (
        !anchor
        || !monolith
        || !partition
        || status?.status !== 'current_complete'
        || monolith.snapshot.id !== anchor.monolithSnapshotId
        || partition.manifestId !== anchor.partitionManifestId
        || partition.configurationVersionId
          !== anchor.partitionConfigurationVersionId
        || partition.configurationHash !== anchor.partitionConfigurationHash
        || !partition.configurationCurrent
        || monolith.verifiedAt.getTime()
          !== anchor.rollbackMonolithVerifiedAt.getTime()
      ) {
        return null;
      }
      const normalizedAnchor = Object.freeze({
        ...anchor,
        rollbackMonolithVerifiedAt: new Date(
          anchor.rollbackMonolithVerifiedAt
        ),
        rollbackMonolithValidUntil: new Date(
          anchor.rollbackMonolithVerifiedAt.getTime() + maximumStalenessMs
        ),
      });
      if (!cache.has(universeId)) {
        cache.set(universeId, Object.freeze({
          anchor: normalizedAnchor,
          monolith,
        }));
      }
      return normalizedAnchor;
    },
    retrieveMonolithPinned: async (input: Readonly<{
      universeId: string;
      snapshotId: string;
      query: BackstageNotionRagQuery;
      cursor: string | null;
    }>) => {
      const cached = requireCache(
        input.universeId,
        input.snapshotId
      );
      const repository = Object.freeze({
        loadActiveSnapshotHeader: async (universeId: string) => (
          universeId === input.universeId ? cached.monolith : null
        ),
        resolveSnapshotScope:
          monolithRepository.resolveSnapshotScope.bind(monolithRepository),
        loadSnapshotChunkPage:
          monolithRepository.loadSnapshotChunkPage.bind(monolithRepository),
        rankSnapshotCandidates:
          monolithRepository.rankSnapshotCandidates.bind(monolithRepository),
      });
      return runWithBackstageNotionEnrichmentAuthorization(true, () => (
        retrieveBackstageNotionRagContext(
          input.universeId,
          withCursor(input.query, input.cursor),
          {
            repository,
            syncStatusRepository,
            ...(overrides.resolveAuthorityRoot
              ? { resolveAuthorityRoot: overrides.resolveAuthorityRoot }
              : {}),
            embedQuery: sharedEmbedding,
            maximumStalenessMs,
            ...(overrides.now ? { now: overrides.now } : {}),
          }
        )
      ));
    },
    derivePartitionPlan: async (input: Readonly<{
      universeId: string;
      manifestId: string;
      query: BackstageNotionRagQuery;
    }>) => {
      const cached = requireCache(
        input.universeId,
        cache.get(input.universeId)?.anchor.monolithSnapshotId ?? '',
        input.manifestId
      );
      if (cached.anchor.partitionManifestId !== input.manifestId) {
        throw new Error('The cutover validation plan crossed manifests.');
      }
      const plan = deriveBackstageNotionPartitionCutoverValidationPlan(
        input.query
      );
      if (!plan) {
        throw new Error('The production partition planner rejected the case.');
      }
      return plan;
    },
    retrievePartitionPinned: async (input: Readonly<{
      universeId: string;
      manifestId: string;
      plan: BackstageNotionPartitionRetrievalPlan;
      cursor: string | null;
    }>) => {
      const cached = requireCache(
        input.universeId,
        cache.get(input.universeId)?.anchor.monolithSnapshotId ?? '',
        input.manifestId
      );
      const plan: BackstageNotionPartitionRetrievalPlan = Object.freeze({
        ...input.plan,
        query: withCursor(input.plan.query, input.cursor),
      });
      return runWithBackstageNotionEnrichmentAuthorization(true, () => (
        retrieveBackstageNotionPartitionRagContext(
          input.universeId,
          plan,
          {
            repository: partitionRepository,
            resolveRequest: (universeId, intent) => (
              resolveBackstageNotionPartitionPinnedRequest(
                universeId,
                cached.anchor.partitionManifestId,
                intent,
                {
                  repository: partitionRepository,
                  ...(overrides.resolveAuthorityRoot
                    ? { resolveAuthorityRoot: overrides.resolveAuthorityRoot }
                    : {}),
                }
              )
            ),
            resolveScopeRequest: (universeId, lookup) => (
              resolveBackstageNotionPartitionPinnedScopeRequest(
                universeId,
                cached.anchor.partitionManifestId,
                lookup,
                {
                  repository: partitionRepository,
                  ...(overrides.resolveAuthorityRoot
                    ? { resolveAuthorityRoot: overrides.resolveAuthorityRoot }
                    : {}),
                }
              )
            ),
            embedQuery: sharedEmbedding,
            resolveCursorEncryptionSecret: () => cursorSecret,
          }
        )
      ));
    },
    sealEvidence: (
      evidence: BackstageNotionPartitionCutoverValidationAttestation
    ) => evidenceRepository.sealEvidence(evidence),
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

/** Explicit opt-in facade; production startup and request paths never call it. */
export async function validateAndPersistBackstageNotionPartitionCutover(input: {
  readonly universeId: string;
  readonly cases: readonly BackstageNotionPartitionCutoverValidationCase[];
  readonly overrides?: BackstageNotionPartitionCutoverValidationRuntimeOverrides;
}): Promise<BackstageNotionPartitionCutoverValidationAttestation> {
  return validateAndSealBackstageNotionPartitionCutover({
    universeId: input.universeId,
    cases: input.cases,
    dependencies: createBackstageNotionPartitionCutoverValidationDependencies(
      input.overrides
    ),
  });
}
