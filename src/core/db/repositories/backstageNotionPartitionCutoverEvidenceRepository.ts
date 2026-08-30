import type { Pool } from 'pg';

import {
  BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_MAX_AGE_MS,
  BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION,
  type BackstageNotionPartitionCutoverGateEvidence,
  type BackstageNotionPartitionCutoverMemberEvidence,
} from '@shared/backstage/backstageNotionPartitionCutoverGate.js';
import {
  BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE,
} from '@shared/backstage/backstageNotionPartitionCore.js';
import {
  BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT,
} from '@shared/backstage/backstageNotionSyncCore.js';
import { getPool } from '../client.js';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHARD_KEY_PATTERN = /^[a-z0-9][a-z0-9._:/-]{0,127}$/u;
const MAX_VALIDATION_CASES = 64;
const MAX_VALIDATION_REQUESTS = 262_144;
const MAX_VALIDATION_CITATIONS = 2_000_000;

type TimestampValue = Date | string;

export interface BackstageNotionPartitionCutoverValidationAnchorRecord {
  readonly universeId: string;
  readonly monolithSnapshotId: string;
  readonly partitionManifestId: string;
  readonly partitionConfigurationVersionId: string;
  readonly partitionConfigurationHash: string;
  readonly partitionSourceGenerationId: string;
  readonly partitionSourceDigest: string;
  readonly partitionSourceVerificationHash: string;
  readonly reconciliationGeneration: number;
  readonly rollbackMonolithVerifiedAt: Date;
}

/** Structural subset accepted from the explicit representative-query validator. */
export interface SealBackstageNotionPartitionCutoverEvidenceInput {
  readonly version: number;
  readonly universeId: string;
  readonly monolithSnapshotId: string;
  readonly partitionManifestId: string;
  readonly partitionConfigurationVersionId: string;
  readonly partitionConfigurationHash: string;
  readonly partitionSourceGenerationId: string;
  readonly partitionSourceDigest: string;
  readonly partitionSourceVerificationHash: string;
  readonly reconciliationGeneration: number;
  readonly rollbackMonolithVerifiedAt: Date | string;
  readonly rollbackMonolithValidUntil: Date | string;
  readonly caseCount: number;
  readonly exactScopeCaseCount: number;
  readonly relevantCaseCount: number;
  readonly completeScopeCaseCount: number;
  readonly cursorContinuationCaseCount: number;
  readonly monolithRequestCount: number;
  readonly partitionRequestCount: number;
  readonly citationCount: number;
  readonly exactScopeParityPassed: true;
  readonly relevantRetrievalParityPassed: true;
  readonly completeScopeParityPassed: true;
  readonly cursorStabilityPassed: true;
  readonly attestationDigest: string;
  readonly validatedAt: Date | string;
}

export interface BackstageNotionPartitionCutoverEvidenceRepository {
  loadValidationAnchor(
    universeId: string
  ): Promise<BackstageNotionPartitionCutoverValidationAnchorRecord | null>;
  sealEvidence(
    input: SealBackstageNotionPartitionCutoverEvidenceInput
  ): Promise<void>;
  loadGateEvidence(input: Readonly<{
    universeId: string;
    configurationHash: string;
    configuredShardKeys: readonly string[];
    maximumStalenessMs: number;
  }>): Promise<BackstageNotionPartitionCutoverGateEvidence | null>;
}

interface ValidationAnchorRow {
  universe_id: string;
  monolith_snapshot_id: string;
  partition_manifest_id: string;
  partition_configuration_version_id: string;
  partition_configuration_hash: string;
  partition_source_generation_id: string;
  partition_source_digest: string;
  partition_source_verification_hash: string;
  reconciliation_generation: number | string;
  rollback_monolith_verified_at: TimestampValue;
}

interface GateEvidenceRow {
  observed_at: TimestampValue;
  universe_id: string;
  evidence_version: number | string;
  evidence_reconciliation_generation: number | string;
  active_reconciliation_generation: number | string;
  published_reconciliation_generation: number | string;
  manifest_id: string;
  active_manifest_id: string;
  manifest_state: string;
  manifest_configuration_version_id: string;
  active_configuration_version_id: string;
  configuration_hash: string;
  active_configuration_hash: string;
  source_generation_id: string;
  source_digest: string;
  source_page_count: number | string;
  source_chunk_count: number | string;
  source_verified_at: TimestampValue;
  source_verification_hash: string;
  manifest_page_count: number | string;
  manifest_chunk_count: number | string;
  embedding_model: string;
  index_format_version: number | string;
  member_count: number | string;
  omission_count: number | string;
  shard_key: string;
  shard_snapshot_id: string;
  shard_source_generation_id: string;
  shard_index_format_version: number | string;
  shard_page_count: number | string;
  shard_chunk_count: number | string;
  member_decision: string;
  member_readable: boolean;
  active_lease_count: number | string;
  unresolved_activation_count: number | string;
  rollback_monolith_snapshot_id: string;
  rollback_monolith_chunk_count: number | string;
  rollback_monolith_verified_at: TimestampValue;
  rollback_monolith_valid_until: TimestampValue;
  rollback_monolith_readable: boolean;
  shadow_comparison_completed: boolean;
  exact_scope_parity_passed: boolean;
  relevant_retrieval_parity_passed: boolean;
  complete_scope_parity_passed: boolean;
  cursor_stability_passed: boolean;
  case_count: number | string;
  exact_scope_case_count: number | string;
  relevant_case_count: number | string;
  complete_scope_case_count: number | string;
  cursor_continuation_case_count: number | string;
  monolith_request_count: number | string;
  partition_request_count: number | string;
  citation_count: number | string;
  attestation_digest: string;
  validated_at: TimestampValue;
  expires_at: TimestampValue;
}

const GATE_MEMBER_ROW_FIELDS = new Set<keyof GateEvidenceRow>([
  'shard_key',
  'shard_snapshot_id',
  'shard_source_generation_id',
  'shard_index_format_version',
  'shard_page_count',
  'shard_chunk_count',
  'member_decision',
  'member_readable',
]);

const GATE_TIMESTAMP_ROW_FIELDS = new Set<keyof GateEvidenceRow>([
  'observed_at',
  'source_verified_at',
  'rollback_monolith_verified_at',
  'validated_at',
  'expires_at',
]);

function assertSharedGateRowConsistency(
  first: GateEvidenceRow,
  row: GateEvidenceRow,
  label: string
): void {
  for (const key of Object.keys(first) as (keyof GateEvidenceRow)[]) {
    if (GATE_MEMBER_ROW_FIELDS.has(key)) {
      continue;
    }
    if (GATE_TIMESTAMP_ROW_FIELDS.has(key)) {
      if (
        requireDate(first[key] as TimestampValue, `${label}.${key}.first`).getTime()
          !== requireDate(row[key] as TimestampValue, `${label}.${key}`).getTime()
      ) {
        throw new Error('Partition cutover gate rows crossed authority generations.');
      }
      continue;
    }
    if (String(first[key]) !== String(row[key])) {
      throw new Error('Partition cutover gate rows crossed authority generations.');
    }
  }
}

export class BackstageNotionPartitionCutoverEvidenceUnavailableError
  extends Error {
  constructor() {
    super('The Backstage Notion partition cutover evidence repository is unavailable.');
    this.name = 'BackstageNotionPartitionCutoverEvidenceUnavailableError';
  }
}

function requireUniverseId(value: string): string {
  if (!UNIVERSE_ID_PATTERN.test(value)) {
    throw new TypeError('universeId is invalid.');
  }
  return value;
}

function requireUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value.toLowerCase();
}

function requireSha256(value: string, label: string): string {
  if (!SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function requireEmbeddingModel(value: string): string {
  if (
    typeof value !== 'string'
    || value !== value.trim()
    || value.length < 1
    || value.length > 200
  ) {
    throw new TypeError('embedding_model is invalid.');
  }
  return value;
}

function requireDate(value: Date | string, label: string): Date {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new TypeError(`${label} is invalid.`);
  }
  return date;
}

function parseInteger(
  value: number | string,
  label: string,
  minimum: number,
  maximum: number
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (
    !Number.isSafeInteger(parsed)
    || parsed < minimum
    || parsed > maximum
  ) {
    throw new Error(`${label} is outside its bounded range.`);
  }
  return parsed;
}

function requireInputInteger(
  value: number,
  label: string,
  minimum: number,
  maximum: number
): number {
  return parseInteger(value, label, minimum, maximum);
}

function requireTrue(value: unknown, label: string): true {
  if (value !== true) {
    throw new TypeError(`${label} must be true.`);
  }
  return true;
}

function normalizeShardKeys(value: readonly string[]): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
    || value.some(key => !SHARD_KEY_PATTERN.test(key))
    || new Set(value).size !== value.length
  ) {
    throw new TypeError('configuredShardKeys is invalid.');
  }
  return Object.freeze([...value].sort((left, right) => (
    left < right ? -1 : left > right ? 1 : 0
  )));
}

function normalizeSealInput(
  input: SealBackstageNotionPartitionCutoverEvidenceInput
): SealBackstageNotionPartitionCutoverEvidenceInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('cutover evidence is invalid.');
  }
  const caseCount = requireInputInteger(
    input.caseCount,
    'caseCount',
    3,
    MAX_VALIDATION_CASES
  );
  const exactScopeCaseCount = requireInputInteger(
    input.exactScopeCaseCount,
    'exactScopeCaseCount',
    1,
    caseCount
  );
  const relevantCaseCount = requireInputInteger(
    input.relevantCaseCount,
    'relevantCaseCount',
    1,
    caseCount
  );
  const completeScopeCaseCount = requireInputInteger(
    input.completeScopeCaseCount,
    'completeScopeCaseCount',
    1,
    caseCount
  );
  const cursorContinuationCaseCount = requireInputInteger(
    input.cursorContinuationCaseCount,
    'cursorContinuationCaseCount',
    1,
    completeScopeCaseCount
  );
  if (
    exactScopeCaseCount + relevantCaseCount + completeScopeCaseCount
      !== caseCount
  ) {
    throw new TypeError('cutover evidence case counts are inconsistent.');
  }
  const validatedAt = requireDate(input.validatedAt, 'validatedAt');
  const rollbackMonolithVerifiedAt = requireDate(
    input.rollbackMonolithVerifiedAt,
    'rollbackMonolithVerifiedAt'
  );
  const rollbackMonolithValidUntil = requireDate(
    input.rollbackMonolithValidUntil,
    'rollbackMonolithValidUntil'
  );
  if (
    rollbackMonolithVerifiedAt.getTime() > validatedAt.getTime()
    || rollbackMonolithValidUntil.getTime() <= validatedAt.getTime()
    || rollbackMonolithValidUntil.getTime()
      - rollbackMonolithVerifiedAt.getTime() > 7 * 24 * 60 * 60 * 1_000
  ) {
    throw new TypeError('rollback monolith freshness is invalid.');
  }
  return Object.freeze({
    version: requireInputInteger(
      input.version,
      'version',
      BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION,
      BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION
    ),
    universeId: requireUniverseId(input.universeId),
    monolithSnapshotId: requireUuid(
      input.monolithSnapshotId,
      'monolithSnapshotId'
    ),
    partitionManifestId: requireUuid(
      input.partitionManifestId,
      'partitionManifestId'
    ),
    partitionConfigurationVersionId: requireUuid(
      input.partitionConfigurationVersionId,
      'partitionConfigurationVersionId'
    ),
    partitionConfigurationHash: requireSha256(
      input.partitionConfigurationHash,
      'partitionConfigurationHash'
    ),
    partitionSourceGenerationId: requireUuid(
      input.partitionSourceGenerationId,
      'partitionSourceGenerationId'
    ),
    partitionSourceDigest: requireSha256(
      input.partitionSourceDigest,
      'partitionSourceDigest'
    ),
    partitionSourceVerificationHash: requireSha256(
      input.partitionSourceVerificationHash,
      'partitionSourceVerificationHash'
    ),
    reconciliationGeneration: requireInputInteger(
      input.reconciliationGeneration,
      'reconciliationGeneration',
      1,
      Number.MAX_SAFE_INTEGER
    ),
    rollbackMonolithVerifiedAt,
    rollbackMonolithValidUntil,
    caseCount,
    exactScopeCaseCount,
    relevantCaseCount,
    completeScopeCaseCount,
    cursorContinuationCaseCount,
    monolithRequestCount: requireInputInteger(
      input.monolithRequestCount,
      'monolithRequestCount',
      caseCount,
      MAX_VALIDATION_REQUESTS
    ),
    partitionRequestCount: requireInputInteger(
      input.partitionRequestCount,
      'partitionRequestCount',
      caseCount,
      MAX_VALIDATION_REQUESTS
    ),
    citationCount: requireInputInteger(
      input.citationCount,
      'citationCount',
      caseCount,
      MAX_VALIDATION_CITATIONS
    ),
    exactScopeParityPassed: requireTrue(
      input.exactScopeParityPassed,
      'exactScopeParityPassed'
    ),
    relevantRetrievalParityPassed: requireTrue(
      input.relevantRetrievalParityPassed,
      'relevantRetrievalParityPassed'
    ),
    completeScopeParityPassed: requireTrue(
      input.completeScopeParityPassed,
      'completeScopeParityPassed'
    ),
    cursorStabilityPassed: requireTrue(
      input.cursorStabilityPassed,
      'cursorStabilityPassed'
    ),
    attestationDigest: requireSha256(
      input.attestationDigest,
      'attestationDigest'
    ),
    validatedAt,
  });
}

const COMPLETE_LIVE_MANIFEST_PREDICATE = `
  authority_head.authority = 'notion'
  AND authority_head.active_snapshot_id = rollback_snapshot.id
  AND authority_head.last_verified_at IS NOT NULL
  AND rollback_snapshot.chunk_count BETWEEN 1 AND
    ${BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT}
  AND rollback_snapshot.chunk_count = (
    SELECT COUNT(*)
    FROM public.backstage_notion_snapshot_chunks AS monolith_chunk
    WHERE monolith_chunk.universe_id = rollback_snapshot.universe_id
      AND monolith_chunk.snapshot_id = rollback_snapshot.id
  )
  AND rollback_snapshot.page_count = (
    SELECT COUNT(*)
    FROM public.backstage_notion_snapshot_pages AS monolith_page
    WHERE monolith_page.universe_id = rollback_snapshot.universe_id
      AND monolith_page.snapshot_id = rollback_snapshot.id
  )
  AND latest_sync.outcome IN ('activated', 'unchanged')
  AND latest_sync.completed_at IS NOT NULL
  AND latest_sync.completed_at >= latest_sync.started_at
  AND latest_sync.activated_snapshot_id = rollback_snapshot.id
  AND latest_sync.failure_phase IS NULL
  AND latest_sync.failure_reason IS NULL
  AND partition_head.active_manifest_id = manifest.id
  AND partition_head.active_configuration_version_id = configuration.id
  AND partition_head.desired_configuration_version_id = configuration.id
  AND partition_head.desired_configuration_generation =
    configuration.configuration_generation
  AND partition_head.desired_configuration_hash = configuration.configuration_hash
  AND partition_head.reconciliation_generation > 0
  AND partition_head.published_reconciliation_generation =
    partition_head.reconciliation_generation
  AND manifest.partition_configuration_version_id = configuration.id
  AND manifest.configuration_generation = configuration.configuration_generation
  AND manifest.configuration_hash = configuration.configuration_hash
  AND manifest.state = 'sealed'
  AND manifest.index_format_version = 1
  AND manifest.member_count = configuration.shard_count
  AND manifest.omission_count = 0
  AND manifest.source_page_count = manifest.page_count
  AND manifest.source_chunk_count = manifest.chunk_count
  AND source_generation.partition_configuration_version_id = configuration.id
  AND source_generation.source_digest = manifest.source_digest
  AND source_generation.source_page_count = manifest.source_page_count
  AND source_generation.source_chunk_count = manifest.source_chunk_count
  AND source_generation.source_verified_at = manifest.source_verified_at
  AND source_generation.source_verification_hash =
    manifest.source_verification_hash
  AND source_generation.member_count = configuration.shard_count
  AND NOT EXISTS (
    SELECT 1
    FROM public.backstage_notion_universe_manifest_omissions AS omission
    WHERE omission.universe_id = manifest.universe_id
      AND omission.manifest_id = manifest.id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM public.backstage_notion_partition_configuration_members AS configured
    LEFT JOIN public.backstage_notion_universe_manifest_shards AS member
      ON member.universe_id = configured.universe_id
     AND member.manifest_id = manifest.id
     AND member.shard_key = configured.shard_key
     AND member.partition_version_id = configured.partition_version_id
    LEFT JOIN public.backstage_notion_shard_snapshots AS shard_snapshot
      ON shard_snapshot.universe_id = member.universe_id
     AND shard_snapshot.shard_key = member.shard_key
     AND shard_snapshot.partition_version_id = member.partition_version_id
     AND shard_snapshot.id = member.shard_snapshot_id
    WHERE configured.universe_id = manifest.universe_id
      AND configured.partition_configuration_version_id = configuration.id
      AND (
        member.shard_key IS NULL
        OR member.decision <> 'fresh'
        OR member.is_required IS DISTINCT FROM configured.is_required
        OR shard_snapshot.state <> 'sealed'
        OR shard_snapshot.source_generation_id IS DISTINCT FROM
          manifest.source_generation_id
        OR shard_snapshot.embedding_model <> manifest.embedding_model
        OR shard_snapshot.embedding_version <> manifest.embedding_version
        OR shard_snapshot.embedding_dimension <> manifest.embedding_dimension
        OR shard_snapshot.index_format_version <> manifest.index_format_version
      )
  )
  AND manifest.page_count = (
    SELECT COALESCE(SUM(shard_snapshot.page_count), 0)
    FROM public.backstage_notion_universe_manifest_shards AS member
    JOIN public.backstage_notion_shard_snapshots AS shard_snapshot
      ON shard_snapshot.universe_id = member.universe_id
     AND shard_snapshot.shard_key = member.shard_key
     AND shard_snapshot.id = member.shard_snapshot_id
    WHERE member.universe_id = manifest.universe_id
      AND member.manifest_id = manifest.id
  )
  AND manifest.chunk_count = (
    SELECT COALESCE(SUM(shard_snapshot.chunk_count), 0)
    FROM public.backstage_notion_universe_manifest_shards AS member
    JOIN public.backstage_notion_shard_snapshots AS shard_snapshot
      ON shard_snapshot.universe_id = member.universe_id
     AND shard_snapshot.shard_key = member.shard_key
     AND shard_snapshot.id = member.shard_snapshot_id
    WHERE member.universe_id = manifest.universe_id
      AND member.manifest_id = manifest.id
  )
  AND manifest.page_count = (
    SELECT COUNT(*)
    FROM public.backstage_notion_manifest_page_ownership AS ownership
    WHERE ownership.universe_id = manifest.universe_id
      AND ownership.manifest_id = manifest.id
  )`;

export class PostgresBackstageNotionPartitionCutoverEvidenceRepository
implements BackstageNotionPartitionCutoverEvidenceRepository {
  constructor(private readonly pool: Pool) {}

  async loadValidationAnchor(
    universeId: string
  ): Promise<BackstageNotionPartitionCutoverValidationAnchorRecord | null> {
    const normalizedUniverseId = requireUniverseId(universeId);
    const result = await this.pool.query<ValidationAnchorRow>(
      `SELECT
         authority_head.universe_id,
         rollback_snapshot.id AS monolith_snapshot_id,
         manifest.id AS partition_manifest_id,
         configuration.id AS partition_configuration_version_id,
         configuration.configuration_hash AS partition_configuration_hash,
         manifest.source_generation_id AS partition_source_generation_id,
         manifest.source_digest AS partition_source_digest,
         manifest.source_verification_hash
           AS partition_source_verification_hash,
         partition_head.reconciliation_generation,
         authority_head.last_verified_at AS rollback_monolith_verified_at
       FROM public.backstage_notion_universe_heads AS authority_head
       JOIN public.backstage_notion_snapshots AS rollback_snapshot
         ON rollback_snapshot.universe_id = authority_head.universe_id
        AND rollback_snapshot.id = authority_head.active_snapshot_id
       JOIN public.backstage_notion_latest_sync_attempts AS latest_sync
         ON latest_sync.universe_id = authority_head.universe_id
       JOIN public.backstage_notion_partitioned_universe_heads AS partition_head
         ON partition_head.universe_id = authority_head.universe_id
       JOIN public.backstage_notion_universe_manifests AS manifest
         ON manifest.universe_id = partition_head.universe_id
        AND manifest.id = partition_head.active_manifest_id
       JOIN public.backstage_notion_partition_configuration_versions AS configuration
         ON configuration.universe_id = partition_head.universe_id
        AND configuration.id = partition_head.active_configuration_version_id
        AND configuration.state = 'sealed'
       JOIN public.backstage_notion_partition_source_generations AS source_generation
         ON source_generation.universe_id = manifest.universe_id
        AND source_generation.source_generation_id = manifest.source_generation_id
       WHERE authority_head.universe_id = $1
         AND ${COMPLETE_LIVE_MANIFEST_PREDICATE}
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_shard_sync_leases AS lease
           WHERE lease.universe_id = authority_head.universe_id
             AND lease.expires_at > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_provider_coordinator_leases AS provider_lease
           WHERE provider_lease.expires_at > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.job_data AS job
           WHERE job.job_type = 'backstage-notion-partition-sync'
             AND job.status IN ('pending', 'running')
             AND job.input ->> 'universeId' = authority_head.universe_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_universe_manifests AS unresolved
           WHERE unresolved.universe_id = authority_head.universe_id
             AND unresolved.state = 'building'
         )`,
      [normalizedUniverseId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (result.rows.length !== 1 || row.universe_id !== normalizedUniverseId) {
      throw new Error('Partition cutover validation anchor is inconsistent.');
    }
    return Object.freeze({
      universeId: normalizedUniverseId,
      monolithSnapshotId: requireUuid(
        row.monolith_snapshot_id,
        'monolith_snapshot_id'
      ),
      partitionManifestId: requireUuid(
        row.partition_manifest_id,
        'partition_manifest_id'
      ),
      partitionConfigurationVersionId: requireUuid(
        row.partition_configuration_version_id,
        'partition_configuration_version_id'
      ),
      partitionConfigurationHash: requireSha256(
        row.partition_configuration_hash,
        'partition_configuration_hash'
      ),
      partitionSourceGenerationId: requireUuid(
        row.partition_source_generation_id,
        'partition_source_generation_id'
      ),
      partitionSourceDigest: requireSha256(
        row.partition_source_digest,
        'partition_source_digest'
      ),
      partitionSourceVerificationHash: requireSha256(
        row.partition_source_verification_hash,
        'partition_source_verification_hash'
      ),
      reconciliationGeneration: parseInteger(
        row.reconciliation_generation,
        'reconciliation_generation',
        1,
        Number.MAX_SAFE_INTEGER
      ),
      rollbackMonolithVerifiedAt: requireDate(
        row.rollback_monolith_verified_at,
        'rollback_monolith_verified_at'
      ),
    });
  }

  async sealEvidence(
    input: SealBackstageNotionPartitionCutoverEvidenceInput
  ): Promise<void> {
    const evidence = normalizeSealInput(input);
    const result = await this.pool.query<{ universe_id: string }>(
      `INSERT INTO public.backstage_notion_partition_cutover_evidence (
         universe_id,
         evidence_version,
         manifest_id,
         partition_configuration_version_id,
         configuration_hash,
         source_generation_id,
         source_digest,
         source_page_count,
         source_chunk_count,
         source_verified_at,
         source_verification_hash,
         rollback_monolith_snapshot_id,
         reconciliation_generation,
         rollback_validation_verified_at,
         rollback_validation_valid_until,
         case_count,
         exact_scope_case_count,
         relevant_case_count,
         complete_scope_case_count,
         cursor_continuation_case_count,
         monolith_request_count,
         partition_request_count,
         citation_count,
         shadow_comparison_completed,
         exact_scope_parity_passed,
         relevant_retrieval_parity_passed,
         complete_scope_parity_passed,
         cursor_stability_passed,
         attestation_digest,
         validated_at,
         expires_at,
         created_at,
         updated_at
       )
       SELECT
         authority_head.universe_id,
         $9,
         manifest.id,
         configuration.id,
         configuration.configuration_hash,
         manifest.source_generation_id,
         manifest.source_digest,
         manifest.source_page_count,
         manifest.source_chunk_count,
         manifest.source_verified_at,
         manifest.source_verification_hash,
         rollback_snapshot.id,
         partition_head.reconciliation_generation,
         $26::TIMESTAMPTZ,
         $27::TIMESTAMPTZ,
         $10,
         $11,
         $12,
         $13,
         $14,
         $15,
         $16,
         $17,
         TRUE,
         $18,
         $19,
         $20,
         $21,
         $22,
         $23::TIMESTAMPTZ,
         LEAST(
           $23::TIMESTAMPTZ + ($24::BIGINT * INTERVAL '1 millisecond'),
           $27::TIMESTAMPTZ
         ),
         statement_timestamp(),
         statement_timestamp()
       FROM public.backstage_notion_universe_heads AS authority_head
       JOIN public.backstage_notion_snapshots AS rollback_snapshot
         ON rollback_snapshot.universe_id = authority_head.universe_id
        AND rollback_snapshot.id = authority_head.active_snapshot_id
       JOIN public.backstage_notion_latest_sync_attempts AS latest_sync
         ON latest_sync.universe_id = authority_head.universe_id
       JOIN public.backstage_notion_partitioned_universe_heads AS partition_head
         ON partition_head.universe_id = authority_head.universe_id
       JOIN public.backstage_notion_universe_manifests AS manifest
         ON manifest.universe_id = partition_head.universe_id
        AND manifest.id = partition_head.active_manifest_id
       JOIN public.backstage_notion_partition_configuration_versions AS configuration
         ON configuration.universe_id = partition_head.universe_id
        AND configuration.id = partition_head.active_configuration_version_id
        AND configuration.state = 'sealed'
       JOIN public.backstage_notion_partition_source_generations AS source_generation
         ON source_generation.universe_id = manifest.universe_id
        AND source_generation.source_generation_id = manifest.source_generation_id
       WHERE authority_head.universe_id = $1
         AND rollback_snapshot.id = $2::UUID
         AND manifest.id = $3::UUID
         AND configuration.id = $4::UUID
         AND configuration.configuration_hash = $5
         AND manifest.source_generation_id = $6::UUID
         AND manifest.source_digest = $7
         AND manifest.source_verification_hash = $8
         AND partition_head.reconciliation_generation = $25::BIGINT
         AND authority_head.last_verified_at = $26::TIMESTAMPTZ
         AND $27::TIMESTAMPTZ > $23::TIMESTAMPTZ
         AND $27::TIMESTAMPTZ <=
           $26::TIMESTAMPTZ + INTERVAL '7 days'
         AND $23::TIMESTAMPTZ <= statement_timestamp()
         AND ${COMPLETE_LIVE_MANIFEST_PREDICATE}
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_shard_sync_leases AS lease
           WHERE lease.universe_id = authority_head.universe_id
             AND lease.expires_at > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_provider_coordinator_leases AS provider_lease
           WHERE provider_lease.expires_at > statement_timestamp()
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.job_data AS job
           WHERE job.job_type = 'backstage-notion-partition-sync'
             AND job.status IN ('pending', 'running')
             AND job.input ->> 'universeId' = authority_head.universe_id
         )
         AND NOT EXISTS (
           SELECT 1
           FROM public.backstage_notion_universe_manifests AS unresolved
           WHERE unresolved.universe_id = authority_head.universe_id
             AND unresolved.state = 'building'
         )
       ON CONFLICT (universe_id) DO UPDATE SET
         evidence_version = EXCLUDED.evidence_version,
         manifest_id = EXCLUDED.manifest_id,
         partition_configuration_version_id =
           EXCLUDED.partition_configuration_version_id,
         configuration_hash = EXCLUDED.configuration_hash,
         source_generation_id = EXCLUDED.source_generation_id,
         source_digest = EXCLUDED.source_digest,
         source_page_count = EXCLUDED.source_page_count,
         source_chunk_count = EXCLUDED.source_chunk_count,
         source_verified_at = EXCLUDED.source_verified_at,
         source_verification_hash = EXCLUDED.source_verification_hash,
         rollback_monolith_snapshot_id = EXCLUDED.rollback_monolith_snapshot_id,
         reconciliation_generation = EXCLUDED.reconciliation_generation,
         rollback_validation_verified_at = EXCLUDED.rollback_validation_verified_at,
         rollback_validation_valid_until = EXCLUDED.rollback_validation_valid_until,
         case_count = EXCLUDED.case_count,
         exact_scope_case_count = EXCLUDED.exact_scope_case_count,
         relevant_case_count = EXCLUDED.relevant_case_count,
         complete_scope_case_count = EXCLUDED.complete_scope_case_count,
         cursor_continuation_case_count =
           EXCLUDED.cursor_continuation_case_count,
         monolith_request_count = EXCLUDED.monolith_request_count,
         partition_request_count = EXCLUDED.partition_request_count,
         citation_count = EXCLUDED.citation_count,
         shadow_comparison_completed = EXCLUDED.shadow_comparison_completed,
         exact_scope_parity_passed = EXCLUDED.exact_scope_parity_passed,
         relevant_retrieval_parity_passed =
           EXCLUDED.relevant_retrieval_parity_passed,
         complete_scope_parity_passed = EXCLUDED.complete_scope_parity_passed,
         cursor_stability_passed = EXCLUDED.cursor_stability_passed,
         attestation_digest = EXCLUDED.attestation_digest,
         validated_at = EXCLUDED.validated_at,
         expires_at = EXCLUDED.expires_at,
         updated_at = statement_timestamp()
       RETURNING universe_id`,
      [
        evidence.universeId,
        evidence.monolithSnapshotId,
        evidence.partitionManifestId,
        evidence.partitionConfigurationVersionId,
        evidence.partitionConfigurationHash,
        evidence.partitionSourceGenerationId,
        evidence.partitionSourceDigest,
        evidence.partitionSourceVerificationHash,
        evidence.version,
        evidence.caseCount,
        evidence.exactScopeCaseCount,
        evidence.relevantCaseCount,
        evidence.completeScopeCaseCount,
        evidence.cursorContinuationCaseCount,
        evidence.monolithRequestCount,
        evidence.partitionRequestCount,
        evidence.citationCount,
        evidence.exactScopeParityPassed,
        evidence.relevantRetrievalParityPassed,
        evidence.completeScopeParityPassed,
        evidence.cursorStabilityPassed,
        evidence.attestationDigest,
        requireDate(evidence.validatedAt, 'validatedAt').toISOString(),
        BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_MAX_AGE_MS,
        evidence.reconciliationGeneration,
        requireDate(
          evidence.rollbackMonolithVerifiedAt,
          'rollbackMonolithVerifiedAt'
        ).toISOString(),
        requireDate(
          evidence.rollbackMonolithValidUntil,
          'rollbackMonolithValidUntil'
        ).toISOString(),
      ]
    );
    if (result.rows.length !== 1 || result.rows[0]?.universe_id !== evidence.universeId) {
      throw new Error('Partition cutover evidence lost its exact validation anchor.');
    }
  }

  async loadGateEvidence(input: Readonly<{
    universeId: string;
    configurationHash: string;
    configuredShardKeys: readonly string[];
    maximumStalenessMs: number;
  }>): Promise<BackstageNotionPartitionCutoverGateEvidence | null> {
    const universeId = requireUniverseId(input.universeId);
    const configurationHash = requireSha256(
      input.configurationHash,
      'configurationHash'
    );
    const configuredShardKeys = normalizeShardKeys(input.configuredShardKeys);
    const maximumStalenessMs = requireInputInteger(
      input.maximumStalenessMs,
      'maximumStalenessMs',
      5 * 60 * 1_000,
      7 * 24 * 60 * 60 * 1_000
    );
    const result = await this.pool.query<GateEvidenceRow>(
      `WITH pinned AS MATERIALIZED (
         SELECT
           statement_timestamp() AS observed_at,
           evidence.*,
           authority_head.last_verified_at AS rollback_monolith_verified_at,
           rollback_snapshot.chunk_count AS rollback_monolith_chunk_count,
           (
             authority_head.authority = 'notion'
             AND authority_head.active_snapshot_id = rollback_snapshot.id
             AND rollback_snapshot.id = evidence.rollback_monolith_snapshot_id
             AND rollback_snapshot.chunk_count BETWEEN 1 AND
               ${BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT}
             AND rollback_snapshot.chunk_count = (
               SELECT COUNT(*)
               FROM public.backstage_notion_snapshot_chunks AS monolith_chunk
               WHERE monolith_chunk.universe_id = rollback_snapshot.universe_id
                 AND monolith_chunk.snapshot_id = rollback_snapshot.id
             )
             AND rollback_snapshot.page_count = (
               SELECT COUNT(*)
               FROM public.backstage_notion_snapshot_pages AS monolith_page
               WHERE monolith_page.universe_id = rollback_snapshot.universe_id
                 AND monolith_page.snapshot_id = rollback_snapshot.id
             )
           ) AS rollback_monolith_readable,
           partition_head.active_manifest_id,
           partition_head.active_configuration_version_id,
           partition_head.desired_configuration_hash AS active_configuration_hash,
           partition_head.reconciliation_generation
             AS active_reconciliation_generation,
           partition_head.published_reconciliation_generation,
           manifest.state AS manifest_state,
           manifest.source_generation_id,
           manifest.source_digest,
           manifest.source_page_count,
           manifest.source_chunk_count,
           manifest.source_verified_at,
           manifest.source_verification_hash,
           manifest.page_count AS manifest_page_count,
           manifest.chunk_count AS manifest_chunk_count,
           manifest.embedding_model,
           manifest.index_format_version,
           manifest.member_count,
           manifest.omission_count,
           (
             SELECT COUNT(*)
             FROM public.backstage_notion_shard_sync_leases AS lease
             WHERE lease.universe_id = evidence.universe_id
               AND lease.expires_at > statement_timestamp()
           ) + (
             SELECT COUNT(*)
             FROM public.backstage_notion_provider_coordinator_leases
               AS provider_lease
             WHERE provider_lease.expires_at > statement_timestamp()
           ) AS active_lease_count,
           (
             SELECT COUNT(*)
             FROM public.job_data AS job
             WHERE job.job_type = 'backstage-notion-partition-sync'
               AND job.status IN ('pending', 'running')
               AND job.input ->> 'universeId' = evidence.universe_id
           ) + (
             SELECT COUNT(*)
             FROM public.backstage_notion_universe_manifests AS unresolved
             WHERE unresolved.universe_id = evidence.universe_id
               AND unresolved.state = 'building'
           ) AS unresolved_activation_count
         FROM public.backstage_notion_partition_cutover_evidence AS evidence
         JOIN public.backstage_notion_universe_heads AS authority_head
           ON authority_head.universe_id = evidence.universe_id
         JOIN public.backstage_notion_snapshots AS rollback_snapshot
           ON rollback_snapshot.universe_id = evidence.universe_id
          AND rollback_snapshot.id = authority_head.active_snapshot_id
         JOIN public.backstage_notion_latest_sync_attempts AS latest_sync
           ON latest_sync.universe_id = authority_head.universe_id
         JOIN public.backstage_notion_partitioned_universe_heads AS partition_head
           ON partition_head.universe_id = evidence.universe_id
         JOIN public.backstage_notion_universe_manifests AS manifest
           ON manifest.universe_id = partition_head.universe_id
          AND manifest.id = partition_head.active_manifest_id
          AND manifest.id = evidence.manifest_id
         JOIN public.backstage_notion_partition_configuration_versions
           AS configuration
           ON configuration.universe_id = manifest.universe_id
          AND configuration.id = manifest.partition_configuration_version_id
          AND configuration.state = 'sealed'
         JOIN public.backstage_notion_partition_source_generations
           AS source_generation
           ON source_generation.universe_id = manifest.universe_id
          AND source_generation.source_generation_id =
            manifest.source_generation_id
         WHERE evidence.universe_id = $1
           AND evidence.configuration_hash = $2
           AND evidence.partition_configuration_version_id = configuration.id
           AND evidence.source_generation_id = manifest.source_generation_id
           AND evidence.source_digest = manifest.source_digest
           AND evidence.source_page_count = manifest.source_page_count
           AND evidence.source_chunk_count = manifest.source_chunk_count
           AND evidence.source_verified_at = manifest.source_verified_at
           AND evidence.source_verification_hash =
             manifest.source_verification_hash
           AND evidence.reconciliation_generation =
             partition_head.reconciliation_generation
           AND evidence.rollback_validation_verified_at =
             authority_head.last_verified_at
            AND evidence.expires_at <= evidence.rollback_validation_valid_until
            AND evidence.expires_at >= statement_timestamp()
            AND authority_head.last_verified_at
              + ($4::BIGINT * INTERVAL '1 millisecond')
              >= statement_timestamp()
           AND partition_head.desired_configuration_hash = $2
           AND ${COMPLETE_LIVE_MANIFEST_PREDICATE}
       )
       SELECT
         pinned.observed_at,
         pinned.universe_id,
         pinned.evidence_version,
         pinned.reconciliation_generation
           AS evidence_reconciliation_generation,
         pinned.active_reconciliation_generation,
         pinned.published_reconciliation_generation,
         pinned.manifest_id,
         pinned.active_manifest_id,
         pinned.manifest_state,
         pinned.partition_configuration_version_id
           AS manifest_configuration_version_id,
         pinned.active_configuration_version_id,
         pinned.configuration_hash,
         pinned.active_configuration_hash,
         pinned.source_generation_id,
         pinned.source_digest,
         pinned.source_page_count,
         pinned.source_chunk_count,
         pinned.source_verified_at,
         pinned.source_verification_hash,
         pinned.manifest_page_count,
         pinned.manifest_chunk_count,
         pinned.embedding_model,
         pinned.index_format_version,
         pinned.member_count,
         pinned.omission_count,
         member.shard_key,
         member.shard_snapshot_id,
         shard_snapshot.source_generation_id AS shard_source_generation_id,
         shard_snapshot.index_format_version AS shard_index_format_version,
         shard_snapshot.page_count AS shard_page_count,
         shard_snapshot.chunk_count AS shard_chunk_count,
         member.decision AS member_decision,
         (
           member.decision = 'fresh'
           AND shard_snapshot.state = 'sealed'
           AND shard_snapshot.source_generation_id = pinned.source_generation_id
           AND shard_snapshot.index_format_version = pinned.index_format_version
         ) AS member_readable,
         pinned.active_lease_count,
         pinned.unresolved_activation_count,
         pinned.rollback_monolith_snapshot_id,
         pinned.rollback_monolith_chunk_count,
          pinned.rollback_monolith_verified_at,
          pinned.rollback_validation_valid_until
            AS rollback_monolith_valid_until,
         pinned.rollback_monolith_readable,
         pinned.shadow_comparison_completed,
         pinned.exact_scope_parity_passed,
         pinned.relevant_retrieval_parity_passed,
         pinned.complete_scope_parity_passed,
         pinned.cursor_stability_passed,
         pinned.case_count,
         pinned.exact_scope_case_count,
         pinned.relevant_case_count,
         pinned.complete_scope_case_count,
         pinned.cursor_continuation_case_count,
         pinned.monolith_request_count,
         pinned.partition_request_count,
         pinned.citation_count,
         pinned.attestation_digest,
         pinned.validated_at,
         pinned.expires_at
       FROM pinned
       JOIN public.backstage_notion_universe_manifest_shards AS member
         ON member.universe_id = pinned.universe_id
        AND member.manifest_id = pinned.manifest_id
       JOIN public.backstage_notion_shard_snapshots AS shard_snapshot
         ON shard_snapshot.universe_id = member.universe_id
        AND shard_snapshot.shard_key = member.shard_key
        AND shard_snapshot.id = member.shard_snapshot_id
       WHERE member.shard_key = ANY($3::TEXT[])
       ORDER BY member.shard_key COLLATE "C"`,
      [
        universeId,
        configurationHash,
        configuredShardKeys,
        maximumStalenessMs,
      ]
    );
    if (result.rows.length === 0) {
      return null;
    }
    const first = result.rows[0]!;
    const observedAt = requireDate(first.observed_at, 'observed_at');
    const sourceGenerationId = requireUuid(
      first.source_generation_id,
      'source_generation_id'
    );
    const indexFormatVersion = parseInteger(
      first.index_format_version,
      'index_format_version',
      1,
      8192
    );
    const members: BackstageNotionPartitionCutoverMemberEvidence[] = [];
    const seen = new Set<string>();
    for (const [index, row] of result.rows.entries()) {
      const label = `gate_rows[${index}]`;
      assertSharedGateRowConsistency(first, row, label);
      const shardKey = row.shard_key;
      if (
        row.universe_id !== universeId
        || requireDate(row.observed_at, `${label}.observed_at`).getTime()
          !== observedAt.getTime()
        || !SHARD_KEY_PATTERN.test(shardKey)
        || seen.has(shardKey)
        || requireUuid(
          row.source_generation_id,
          `${label}.source_generation_id`
        ) !== sourceGenerationId
        || parseInteger(
          row.index_format_version,
          `${label}.index_format_version`,
          1,
          8192
        ) !== indexFormatVersion
      ) {
        throw new Error('Partition cutover gate rows crossed authority generations.');
      }
      seen.add(shardKey);
      members.push(Object.freeze({
        shardKey,
        snapshotId: requireUuid(
          row.shard_snapshot_id,
          `${label}.shard_snapshot_id`
        ),
        sourceGenerationId: requireUuid(
          row.shard_source_generation_id,
          `${label}.shard_source_generation_id`
        ),
        indexFormatVersion: parseInteger(
          row.shard_index_format_version,
          `${label}.shard_index_format_version`,
          1,
          8192
        ),
        pageCount: parseInteger(
          row.shard_page_count,
          `${label}.shard_page_count`,
          1,
          512
        ),
        chunkCount: parseInteger(
          row.shard_chunk_count,
          `${label}.shard_chunk_count`,
          1,
          2_048
        ),
        decision: row.member_decision === 'fresh'
          ? 'fresh'
          : 'retained_last_known_good',
        readable: row.member_readable === true,
      }));
    }
    const rollbackVerifiedAt = requireDate(
      first.rollback_monolith_verified_at,
      'rollback_monolith_verified_at'
    );
    const caseCount = parseInteger(
      first.case_count,
      'case_count',
      3,
      MAX_VALIDATION_CASES
    );
    const exactScopeCaseCount = parseInteger(
      first.exact_scope_case_count,
      'exact_scope_case_count',
      1,
      caseCount
    );
    const relevantCaseCount = parseInteger(
      first.relevant_case_count,
      'relevant_case_count',
      1,
      caseCount
    );
    const completeScopeCaseCount = parseInteger(
      first.complete_scope_case_count,
      'complete_scope_case_count',
      1,
      caseCount
    );
    const cursorContinuationCaseCount = parseInteger(
      first.cursor_continuation_case_count,
      'cursor_continuation_case_count',
      1,
      completeScopeCaseCount
    );
    if (
      exactScopeCaseCount + relevantCaseCount + completeScopeCaseCount
        !== caseCount
      || cursorContinuationCaseCount > completeScopeCaseCount
    ) {
      throw new Error('Partition cutover attestation counts are inconsistent.');
    }
    parseInteger(
      first.monolith_request_count,
      'monolith_request_count',
      caseCount,
      MAX_VALIDATION_REQUESTS
    );
    parseInteger(
      first.partition_request_count,
      'partition_request_count',
      caseCount,
      MAX_VALIDATION_REQUESTS
    );
    parseInteger(
      first.citation_count,
      'citation_count',
      caseCount,
      MAX_VALIDATION_CITATIONS
    );
    requireSha256(first.attestation_digest, 'attestation_digest');
    const reconciliationGeneration = parseInteger(
      first.evidence_reconciliation_generation,
      'evidence_reconciliation_generation',
      1,
      Number.MAX_SAFE_INTEGER
    );
    const activeReconciliationGeneration = parseInteger(
      first.active_reconciliation_generation,
      'active_reconciliation_generation',
      1,
      Number.MAX_SAFE_INTEGER
    );
    const publishedReconciliationGeneration = parseInteger(
      first.published_reconciliation_generation,
      'published_reconciliation_generation',
      1,
      Number.MAX_SAFE_INTEGER
    );
    if (
      reconciliationGeneration !== activeReconciliationGeneration
      || publishedReconciliationGeneration !== activeReconciliationGeneration
    ) {
      throw new Error('Partition cutover evidence is not bound to a published reconciliation.');
    }
    return Object.freeze({
      evidenceVersion: parseInteger(
        first.evidence_version,
        'evidence_version',
        BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION,
        BACKSTAGE_NOTION_PARTITION_CUTOVER_EVIDENCE_VERSION
      ),
      reconciliationGeneration,
      activeReconciliationGeneration,
      publishedReconciliationGeneration,
      universeId,
      manifestId: requireUuid(first.manifest_id, 'manifest_id'),
      activeManifestId: requireUuid(
        first.active_manifest_id,
        'active_manifest_id'
      ),
      manifestState: first.manifest_state === 'sealed' ? 'sealed' : 'building',
      manifestReadable: true,
      manifestConfigurationVersionId: requireUuid(
        first.manifest_configuration_version_id,
        'manifest_configuration_version_id'
      ),
      activeConfigurationVersionId: requireUuid(
        first.active_configuration_version_id,
        'active_configuration_version_id'
      ),
      configurationHash: requireSha256(
        first.configuration_hash,
        'configuration_hash'
      ),
      activeConfigurationHash: requireSha256(
        first.active_configuration_hash,
        'active_configuration_hash'
      ),
      sourceGenerationId,
      sourceDigest: requireSha256(first.source_digest, 'source_digest'),
      sourcePageCount: parseInteger(
        first.source_page_count,
        'source_page_count',
        1,
        65_536
      ),
      sourceChunkCount: parseInteger(
        first.source_chunk_count,
        'source_chunk_count',
        1,
        262_144
      ),
      sourceVerifiedAt: requireDate(
        first.source_verified_at,
        'source_verified_at'
      ),
      sourceVerificationHash: requireSha256(
        first.source_verification_hash,
        'source_verification_hash'
      ),
      manifestPageCount: parseInteger(
        first.manifest_page_count,
        'manifest_page_count',
        1,
        65_536
      ),
      manifestChunkCount: parseInteger(
        first.manifest_chunk_count,
        'manifest_chunk_count',
        1,
        262_144
      ),
      embeddingModel: requireEmbeddingModel(first.embedding_model),
      indexFormatVersion,
      memberCount: parseInteger(
        first.member_count,
        'member_count',
        1,
        BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      ),
      omissionCount: parseInteger(
        first.omission_count,
        'omission_count',
        0,
        BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      ),
      members: Object.freeze(members),
      leaseFencingClear: parseInteger(
        first.active_lease_count,
        'active_lease_count',
        0,
        1_024
      ) === 0,
      unresolvedActivationCount: parseInteger(
        first.unresolved_activation_count,
        'unresolved_activation_count',
        0,
        BACKSTAGE_NOTION_PARTITION_MAX_SHARDS_PER_UNIVERSE
      ),
      parity: Object.freeze({
        shadowComparisonCompleted: first.shadow_comparison_completed === true,
        exactScopeParityPassed: first.exact_scope_parity_passed === true,
        relevantRetrievalParityPassed:
          first.relevant_retrieval_parity_passed === true,
        completeScopeParityPassed: first.complete_scope_parity_passed === true,
        cursorStabilityPassed: first.cursor_stability_passed === true,
      }),
      rollbackMonolithSnapshotId: requireUuid(
        first.rollback_monolith_snapshot_id,
        'rollback_monolith_snapshot_id'
      ),
      rollbackMonolithReadable: first.rollback_monolith_readable === true,
      rollbackMonolithChunkCount: parseInteger(
        first.rollback_monolith_chunk_count,
        'rollback_monolith_chunk_count',
        1,
        BACKSTAGE_NOTION_MAX_READABLE_CHUNKS_PER_SNAPSHOT
      ),
      rollbackMonolithVerifiedAt: rollbackVerifiedAt,
      rollbackMonolithValidUntil: requireDate(
        first.rollback_monolith_valid_until,
        'rollback_monolith_valid_until'
      ),
      verifiedAt: requireDate(first.validated_at, 'validated_at'),
      expiresAt: requireDate(first.expires_at, 'expires_at'),
    });
  }
}

export function getBackstageNotionPartitionCutoverEvidenceRepository():
BackstageNotionPartitionCutoverEvidenceRepository {
  const pool = getPool();
  if (!pool) {
    throw new BackstageNotionPartitionCutoverEvidenceUnavailableError();
  }
  return new PostgresBackstageNotionPartitionCutoverEvidenceRepository(pool);
}
