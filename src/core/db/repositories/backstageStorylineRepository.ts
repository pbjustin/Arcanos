import type { PoolClient } from 'pg';

import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS,
  parseBackstageStorylineSerializedPayload,
  type StorylineBeat
} from '@shared/backstage/backstageStoryline.js';

const BACKSTAGE_STORYLINE_ADVISORY_LOCK_NAMESPACE = 0x41524341;
const BACKSTAGE_STORYLINE_ADVISORY_LOCK_RESOURCE = 0x53544254;

export interface BackstageStorylineMutationResult {
  retainedBeats: StorylineBeat[];
  revision: string;
}

type BackstageStorylineTransactionClient = Pick<PoolClient, 'query'>;

interface InsertedStorylineBeatRow {
  id: string;
}

interface StoredStorylineBeatRow {
  serialized_data: unknown;
}

/**
 * Persist one validated beat and enforce the complete retained timeline atomically.
 * Inputs/outputs: transaction client plus exact compact JSON -> retained chronological beats and revision.
 * Edge cases: legacy rows are admitted only when their database serialization satisfies the new contract;
 * malformed revisions or stored JSON fail the transaction and surface as an unconfirmed persistence error.
 */
export async function applyBackstageStorylineMutation(
  client: BackstageStorylineTransactionClient,
  serializedBeat: string
): Promise<BackstageStorylineMutationResult> {
  // Keep this as the first transaction statement: PostgreSQL permits normalizing an explicit
  // BEGIN ... REPEATABLE READ before any snapshot-establishing query, and the PG18 concurrency
  // regression covers that exact caller sequence.
  await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');

  //audit Assumption: all supported storyline mutations use this fixed transaction-scoped advisory lock; failure risk: replicas prune or publish competing timelines; expected invariant: insert, legacy containment, retention, and read execute serially; handling strategy: acquire one shared lock before inspecting or mutating beat state.
  await client.query(
    'SELECT pg_advisory_xact_lock($1, $2)',
    [
      BACKSTAGE_STORYLINE_ADVISORY_LOCK_NAMESPACE,
      BACKSTAGE_STORYLINE_ADVISORY_LOCK_RESOURCE
    ]
  );

  const revisionResult = await client.query<{ revision: string }>(
    'SELECT txid_current()::TEXT AS revision'
  );
  const revision = revisionResult.rows[0]?.revision;
  if (typeof revision !== 'string' || !/^[0-9]{1,20}$/u.test(revision)) {
    throw new Error('Backstage storyline transaction revision was unavailable.');
  }

  //audit Assumption: pre-contract JSONB rows have no exact caller-byte evidence; failure risk: one legacy row defeats the new response bound; expected invariant: only object rows with a bounded deterministic serialization survive the first mutation; handling strategy: backfill at most the newest retained set from PostgreSQL text, then remove every uncontained row in this same transaction.
  await client.query(
    `WITH newest_legacy AS MATERIALIZED (
       SELECT id, created_at
       FROM backstage_story_beats
       WHERE serialized_data IS NULL
         AND jsonb_typeof(data) = 'object'
         AND created_at IS NOT NULL
         AND isfinite(created_at)
         AND octet_length(convert_to(data::TEXT, 'UTF8')) <= $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2
     ), legacy AS MATERIALIZED (
       SELECT
         id,
         ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::BIGINT
           AS storage_sequence
       FROM newest_legacy
     )
     UPDATE backstage_story_beats AS beat
     SET
       serialized_data = beat.data::TEXT,
       storage_sequence = legacy.storage_sequence
     FROM legacy
     WHERE beat.id = legacy.id`,
    [BACKSTAGE_STORYLINE_MAX_BYTES, BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS]
  );

  await client.query(
    `DELETE FROM backstage_story_beats
     WHERE serialized_data IS NULL`
  );

  await client.query(
    `WITH expired AS MATERIALIZED (
       SELECT id
       FROM backstage_story_beats
       ORDER BY storage_sequence DESC, id DESC
       OFFSET $1
     )
     DELETE FROM backstage_story_beats AS beat
     USING expired
     WHERE beat.id = expired.id`,
    [BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS - 1]
  );

  //audit Assumption: storage_sequence is an internal compact append order, not a caller timestamp; failure risk: manually inserted BIGINT extremes or duplicates poison MAX()+1; expected invariant: every admitted mutation starts from a dense 1..99 order; handling strategy: re-rank the bounded retained rows under the advisory lock before inserting.
  await client.query(
    `WITH ordered AS MATERIALIZED (
       SELECT
         id,
         ROW_NUMBER() OVER (ORDER BY storage_sequence ASC, id ASC)::BIGINT
           AS compact_sequence
       FROM backstage_story_beats
     )
     UPDATE backstage_story_beats AS beat
     SET storage_sequence = ordered.compact_sequence
     FROM ordered
     WHERE beat.id = ordered.id
       AND beat.storage_sequence IS DISTINCT FROM ordered.compact_sequence`
  );

  const insertedResult = await client.query<InsertedStorylineBeatRow>(
    `INSERT INTO backstage_story_beats (
       data,
       serialized_data,
       storage_sequence,
       created_at
     )
     SELECT
       '{}'::JSONB,
       $1::TEXT,
       COALESCE(MAX(storage_sequence), 0) + 1,
       clock_timestamp()
     FROM backstage_story_beats
     RETURNING id`,
    [serializedBeat]
  );
  const insertedId = insertedResult.rows[0]?.id;
  if (typeof insertedId !== 'string' || insertedId.length === 0) {
    throw new Error('Backstage storyline insert could not be confirmed.');
  }

  const retainedResult = await client.query<StoredStorylineBeatRow>(
    `SELECT recent.serialized_data
     FROM (
       SELECT id, serialized_data, storage_sequence
       FROM backstage_story_beats
       ORDER BY
         (id = $1::UUID) DESC,
         storage_sequence DESC,
         id DESC
       LIMIT $2
     ) AS recent
     ORDER BY
       recent.storage_sequence ASC,
       (recent.id = $1::UUID) ASC,
       recent.id ASC`,
    [insertedId, BACKSTAGE_STORYLINE_MAX_RETAINED_BEATS]
  );

  const retainedBeats = retainedResult.rows.map(row =>
    parseBackstageStorylineSerializedPayload(row.serialized_data)
  );

  return { retainedBeats, revision };
}
