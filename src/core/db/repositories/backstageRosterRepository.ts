import type { PoolClient } from 'pg';

import { AUDITED_TRANSIENT_READ_QUERIES } from '../transientReadRegistry.js';
import {
  BackstageRosterValidationError,
  parseBackstageRosterPayload,
  type Wrestler
} from '@shared/backstage/backstageRoster.js';

const BACKSTAGE_ROSTER_ADVISORY_LOCK_NAMESPACE = 0x41524341;
const BACKSTAGE_ROSTER_ADVISORY_LOCK_RESOURCE = 0x524f5354;
const LEGACY_BACKSTAGE_UNIVERSE_ID = 'legacy';
const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export interface BackstageRosterMutationResult {
  roster: Wrestler[];
  revision: string;
}

type BackstageRosterTransactionClient = Pick<PoolClient, 'query'>;

interface StoredBackstageRosterRow {
  name: unknown;
  overall: unknown;
}

function normalizeUniverseId(universeId: string): string {
  const normalized = universeId.trim();
  if (!BACKSTAGE_UNIVERSE_ID_PATTERN.test(normalized)) {
    throw new TypeError('universeId must be a valid Backstage universe identifier.');
  }
  return normalized;
}

function mapStoredBackstageRosterRows(
  rows: readonly StoredBackstageRosterRow[]
): Wrestler[] {
  const roster: Wrestler[] = [];
  const seenNames = new Set<string>();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const rawOverall = row?.overall;
    const overall = typeof rawOverall === 'number'
      ? rawOverall
      : typeof rawOverall === 'string' && /^-?[0-9]+$/u.test(rawOverall)
        ? Number(rawOverall)
        : Number.NaN;
    let wrestler: Wrestler | undefined;
    try {
      [wrestler] = parseBackstageRosterPayload([{
        name: row?.name,
        overall
      }]);
    } catch (error) {
      if (error instanceof BackstageRosterValidationError) {
        throw new BackstageRosterValidationError(
          `Stored roster row at index ${index} is invalid: ${error.message}`
        );
      }
      throw error;
    }
    if (!wrestler) {
      throw new BackstageRosterValidationError(
        `Stored roster row at index ${index} is invalid: roster row is missing.`
      );
    }
    if (seenNames.has(wrestler.name)) {
      throw new BackstageRosterValidationError(
        `Stored roster contains a duplicate normalized name at index ${index}.`
      );
    }
    seenNames.add(wrestler.name);
    roster.push(wrestler);
  }
  return roster;
}

/**
 * Persist one roster mutation while holding the cluster-wide roster lock.
 * Inputs/outputs: transaction client plus validated wrestlers -> committed-state roster and monotonic transaction revision.
 * Edge cases: empty payloads still serialize and return a fresh authoritative read; malformed revisions fail the transaction.
 */
export async function applyBackstageRosterMutation(
  client: BackstageRosterTransactionClient,
  wrestlers: readonly Wrestler[],
  universeId = LEGACY_BACKSTAGE_UNIVERSE_ID
): Promise<BackstageRosterMutationResult> {
  const normalizedUniverseId = normalizeUniverseId(universeId);

  //audit Assumption: legacy mutations can overlap with older replicas while activated non-legacy universes are written only by universe-aware replicas; failure risk: changing the legacy lock identity breaks serialization with old writers, while one global lock needlessly couples independent activated universes; expected invariant: every legacy writer shares the original fixed lock and each non-legacy universe has its own deterministic lock resource; handling strategy: preserve the fixed legacy namespace/resource pair and hash only validated non-legacy universe resources.
  if (normalizedUniverseId === LEGACY_BACKSTAGE_UNIVERSE_ID) {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [
        BACKSTAGE_ROSTER_ADVISORY_LOCK_NAMESPACE,
        BACKSTAGE_ROSTER_ADVISORY_LOCK_RESOURCE
      ]
    );
  } else {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, hashtext($2))',
      [
        BACKSTAGE_ROSTER_ADVISORY_LOCK_NAMESPACE,
        `roster:${normalizedUniverseId}`
      ]
    );
  }

  const revisionResult = await client.query<{ revision: string }>(
    'SELECT txid_current()::TEXT AS revision'
  );
  const revision = revisionResult.rows[0]?.revision;
  if (typeof revision !== 'string' || !/^[0-9]{1,20}$/u.test(revision)) {
    throw new Error('Backstage roster transaction revision was unavailable.');
  }

  if (wrestlers.length > 0) {
    await client.query(
      `INSERT INTO backstage_wrestlers (
         universe_id,
         name,
         overall,
         created_at,
         updated_at
       )
       SELECT $1, incoming.name, incoming.overall, NOW(), NOW()
       FROM UNNEST($2::TEXT[], $3::INTEGER[]) AS incoming(name, overall)
       ON CONFLICT (universe_id, name)
       DO UPDATE SET overall = EXCLUDED.overall, updated_at = NOW()`,
      [
        normalizedUniverseId,
        wrestlers.map(wrestler => wrestler.name),
        wrestlers.map(wrestler => wrestler.overall)
      ]
    );
  }

  const result = await client.query<StoredBackstageRosterRow>(
    AUDITED_TRANSIENT_READ_QUERIES.BACKSTAGE_ROSTER_READ_AFTER_UPDATE.sql,
    [normalizedUniverseId]
  );

  return {
    // Validate the entire authoritative view before returning from the
    // transaction callback so malformed manual/pre-contract rows roll back
    // this mutation instead of surfacing only after COMMIT.
    roster: mapStoredBackstageRosterRows(result.rows),
    revision
  };
}
