import type { PoolClient } from 'pg';

import { AUDITED_TRANSIENT_READ_QUERIES } from '../transientReadRegistry.js';
import type { Wrestler } from '@shared/backstage/backstageRoster.js';

const BACKSTAGE_ROSTER_ADVISORY_LOCK_NAMESPACE = 0x41524341;
const BACKSTAGE_ROSTER_ADVISORY_LOCK_RESOURCE = 0x524f5354;

export interface BackstageRosterMutationResult {
  roster: Wrestler[];
  revision: string;
}

type BackstageRosterTransactionClient = Pick<PoolClient, 'query'>;

/**
 * Persist one roster mutation while holding the cluster-wide roster lock.
 * Inputs/outputs: transaction client plus validated wrestlers -> committed-state roster and monotonic transaction revision.
 * Edge cases: empty payloads still serialize and return a fresh authoritative read; malformed revisions fail the transaction.
 */
export async function applyBackstageRosterMutation(
  client: BackstageRosterTransactionClient,
  wrestlers: readonly Wrestler[]
): Promise<BackstageRosterMutationResult> {
  //audit Assumption: all roster mutations use this fixed transaction-scoped advisory lock; failure risk: concurrent replicas read and publish disjoint uncommitted updates; expected invariant: each mutation observes every earlier committed roster mutation; handling strategy: acquire the shared lock before allocating a transaction revision or touching roster state.
  await client.query(
    'SELECT pg_advisory_xact_lock($1, $2)',
    [
      BACKSTAGE_ROSTER_ADVISORY_LOCK_NAMESPACE,
      BACKSTAGE_ROSTER_ADVISORY_LOCK_RESOURCE
    ]
  );

  const revisionResult = await client.query<{ revision: string }>(
    'SELECT txid_current()::TEXT AS revision'
  );
  const revision = revisionResult.rows[0]?.revision;
  if (typeof revision !== 'string' || !/^[0-9]{1,20}$/u.test(revision)) {
    throw new Error('Backstage roster transaction revision was unavailable.');
  }

  if (wrestlers.length > 0) {
    await client.query(
      `INSERT INTO backstage_wrestlers (name, overall, created_at, updated_at)
       SELECT incoming.name, incoming.overall, NOW(), NOW()
       FROM UNNEST($1::TEXT[], $2::INTEGER[]) AS incoming(name, overall)
       ON CONFLICT (name)
       DO UPDATE SET overall = EXCLUDED.overall, updated_at = NOW()`,
      [
        wrestlers.map(wrestler => wrestler.name),
        wrestlers.map(wrestler => wrestler.overall)
      ]
    );
  }

  const result = await client.query<{ name: string; overall: number | string }>(
    AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql,
    []
  );

  return {
    roster: result.rows.map(row => ({
      name: row.name,
      overall: Number(row.overall)
    })),
    revision
  };
}
