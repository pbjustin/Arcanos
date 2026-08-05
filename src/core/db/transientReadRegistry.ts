function defineAuditedTransientReadQuery<const TId extends string, const TSql extends string>(
  id: TId,
  sql: TSql
): Readonly<{ id: TId; sql: TSql }> {
  return Object.freeze({ id, sql });
}

/**
 * Exact read queries permitted to opt into database retries.
 *
 * Keep this registry intentionally small. Adding a query changes runtime
 * retry semantics and requires focused review of the complete SQL statement.
 */
export const AUDITED_TRANSIENT_READ_QUERIES = Object.freeze({
  BACKSTAGE_PROMPT_ROSTER_RECENT: defineAuditedTransientReadQuery(
    'backstage.prompt.roster-recent.v1',
    'SELECT name, overall, updated_at FROM backstage_wrestlers ORDER BY updated_at DESC LIMIT 25'
  ),
  BACKSTAGE_PROMPT_EVENTS_RECENT: defineAuditedTransientReadQuery(
    'backstage.prompt.events-recent.v1',
    'SELECT data, created_at FROM backstage_events ORDER BY created_at DESC LIMIT 5'
  ),
  BACKSTAGE_PROMPT_STORY_BEATS_RECENT: defineAuditedTransientReadQuery(
    'backstage.prompt.story-beats-recent.v1',
    `SELECT serialized_data, storage_sequence
     FROM backstage_story_beats
     WHERE serialized_data IS NOT NULL
     ORDER BY storage_sequence DESC, id DESC
     LIMIT 5`
  ),
  BACKSTAGE_PROMPT_STORYLINES_RECENT: defineAuditedTransientReadQuery(
    'backstage.prompt.storylines-recent.v1',
    `SELECT story_key, storyline, updated_at
     FROM backstage_storylines
     ORDER BY updated_at DESC NULLS LAST, id DESC
     LIMIT 5`
  ),
  BACKSTAGE_ROSTER_READ_AFTER_UPDATE: defineAuditedTransientReadQuery(
    'backstage.roster.read-after-update.v1',
    'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC'
  ),
  BACKSTAGE_STORYLINE_READ_AFTER_TRACK: defineAuditedTransientReadQuery(
    'backstage.storyline.read-after-track.v1',
    `SELECT recent.serialized_data
     FROM (
       SELECT id, serialized_data, storage_sequence
       FROM backstage_story_beats
       WHERE serialized_data IS NOT NULL
       ORDER BY storage_sequence DESC, id DESC
       LIMIT 100
     ) AS recent
     ORDER BY recent.storage_sequence ASC, recent.id ASC`
  ),
  BACKSTAGE_MATCH_ROSTER_READ: defineAuditedTransientReadQuery(
    'backstage.match.roster-read.v1',
    'SELECT name, overall FROM backstage_wrestlers ORDER BY name ASC'
  )
});

export type AuditedTransientReadQuery =
  typeof AUDITED_TRANSIENT_READ_QUERIES[keyof typeof AUDITED_TRANSIENT_READ_QUERIES];
export type AuditedTransientReadQueryId = AuditedTransientReadQuery['id'];

const AUDITED_QUERY_BY_ID = new Map<string, AuditedTransientReadQuery>(
  Object.values(AUDITED_TRANSIENT_READ_QUERIES).map(definition => [
    definition.id,
    definition
  ])
);

function normalizeSqlIdentity(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function matchesAuditedTransientReadQuery(
  queryId: unknown,
  text: string
): queryId is AuditedTransientReadQueryId {
  if (typeof queryId !== 'string') {
    return false;
  }

  const definition = AUDITED_QUERY_BY_ID.get(queryId);
  return Boolean(
    definition &&
    normalizeSqlIdentity(definition.sql) === normalizeSqlIdentity(text)
  );
}
