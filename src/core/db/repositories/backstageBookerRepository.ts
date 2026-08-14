import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import {
  applyBackstageRosterMutation,
  type BackstageRosterMutationResult
} from './backstageRosterRepository.js';
import {
  applyBackstageStorylineMutation,
  type BackstageStorylineMutationResult
} from './backstageStorylineRepository.js';

export const LEGACY_BACKSTAGE_UNIVERSE_ID = 'legacy';
export const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKSTAGE_SAVED_STORYLINE_ADVISORY_LOCK_NAMESPACE = 0x41524341;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type TimestampValue = Date | string;

export interface BackstageWrestler {
  name: string;
  overall: number;
  updatedAt?: Date;
}

export interface BackstageEventRecord {
  id: string;
  universeId: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface BackstageStoryBeatRecord {
  id: string;
  universeId: string;
  data: Record<string, unknown>;
  createdAt: Date;
}

export interface BackstageStorylineRecord {
  id: string;
  universeId: string;
  storyKey: string;
  storyline: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackstageSavedStorylineMutationResult extends BackstageStorylineRecord {
  revision: string;
}

export interface BackstageContext {
  roster: BackstageWrestler[];
  events: BackstageEventRecord[];
  storyBeats: BackstageStoryBeatRecord[];
  storylines: BackstageStorylineRecord[];
}

interface BackstageWrestlerRow {
  name: string;
  overall: number | string;
  updated_at: TimestampValue;
}

interface BackstageEventRow {
  id: string;
  universe_id: string;
  data: unknown;
  created_at: TimestampValue;
}

interface BackstageStoryBeatRow {
  id: string;
  universe_id: string;
  data: unknown;
  serialized_data: unknown;
  created_at: TimestampValue;
}

interface BackstageStorylineRow {
  id: string;
  universe_id: string;
  story_key: string;
  storyline: string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface BackstageUniverseScopeActivationRow {
  activated: boolean;
}

export class BackstageBookerRepositoryUnavailableError extends Error {
  readonly code = 'BACKSTAGE_BOOKER_REPOSITORY_UNAVAILABLE';
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, cause?: unknown) {
    super('Backstage Booker persistence is unavailable.');
    this.name = 'BackstageBookerRepositoryUnavailableError';
    this.operation = operation;
    this.cause = cause;
  }
}

export class BackstageBookerWriteError extends Error {
  readonly code = 'BACKSTAGE_BOOKER_WRITE_FAILED';
  readonly operation: string;
  override readonly cause: unknown;
  readonly rollbackCause: unknown;

  constructor(operation: string, cause: unknown, rollbackCause?: unknown) {
    super('Backstage Booker persistence failed before commit.');
    this.name = 'BackstageBookerWriteError';
    this.operation = operation;
    this.cause = cause;
    this.rollbackCause = rollbackCause;
  }
}

export class BackstageBookerCommitUnknownError extends Error {
  readonly code = 'BACKSTAGE_BOOKER_COMMIT_UNKNOWN';
  readonly operation: string;
  override readonly cause: unknown;

  constructor(operation: string, cause: unknown) {
    super('Backstage Booker commit outcome is unknown.');
    this.name = 'BackstageBookerCommitUnknownError';
    this.operation = operation;
    this.cause = cause;
  }
}

export class BackstageBookerUniverseScopeNotActivatedError extends Error {
  readonly code = 'BACKSTAGE_BOOKER_UNIVERSE_SCOPE_NOT_ACTIVATED';

  constructor() {
    super('Backstage Booker universe-scoped persistence is not activated.');
    this.name = 'BackstageBookerUniverseScopeNotActivatedError';
  }
}

export function isBackstageBookerUniverseScopeNotActivatedError(
  value: unknown
): value is BackstageBookerUniverseScopeNotActivatedError {
  return value instanceof BackstageBookerUniverseScopeNotActivatedError;
}

function normalizeUniverseId(universeId: string): string {
  if (typeof universeId !== 'string') {
    throw new TypeError('universeId must be a string.');
  }
  const normalized = universeId.trim();
  if (!BACKSTAGE_UNIVERSE_ID_PATTERN.test(normalized)) {
    throw new TypeError('universeId must be a valid Backstage universe identifier.');
  }
  return normalized;
}

function hasAtMostCodePoints(value: string, maximum: number): boolean {
  let length = 0;
  for (const _codePoint of value) {
    length += 1;
    if (length > maximum) {
      return false;
    }
  }
  return true;
}

function assertPostgresTextExpressible(value: string, label: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit === 0) {
      throw new TypeError(`${label} must not contain U+0000.`);
    }
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const trailingCodeUnit = value.charCodeAt(index + 1);
      if (!(trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff)) {
        throw new TypeError(`${label} must not contain unpaired UTF-16 surrogates.`);
      }
      index += 1;
      continue;
    }
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError(`${label} must not contain unpaired UTF-16 surrogates.`);
    }
  }
}

function assertPostgresJsonStringsExpressible(value: unknown, label: string): void {
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (typeof current === 'string') {
      assertPostgresTextExpressible(current, `${label} string`);
      continue;
    }
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (current && typeof current === 'object') {
      for (const [key, nestedValue] of Object.entries(current)) {
        assertPostgresTextExpressible(key, `${label} property name`);
        pending.push(nestedValue);
      }
    }
  }
}

function normalizeRequiredString(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  const normalized = value.trim();
  assertPostgresTextExpressible(normalized, label);
  if (normalized.length < 1 || !hasAtMostCodePoints(normalized, maxLength)) {
    throw new TypeError(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function validateRequiredContent(value: string, label: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string.`);
  }
  assertPostgresTextExpressible(value, label);
  if (!hasAtMostCodePoints(value, maxLength) || value.trim().length < 1) {
    throw new TypeError(`${label} must contain between 1 and ${maxLength} characters.`);
  }
  return value;
}

function normalizeEventId(id: string): string {
  if (!UUID_PATTERN.test(id)) {
    throw new TypeError('eventId must be a UUID.');
  }
  return id.toLowerCase();
}

function serializeJsonObject(
  value: Record<string, unknown>,
  label: string,
  requirePostgresJsonbText = false
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }

  let serialized: string | undefined;
  let normalizedValue: unknown;
  try {
    serialized = JSON.stringify(value);
    normalizedValue = requirePostgresJsonbText && serialized
      ? JSON.parse(serialized)
      : undefined;
  } catch {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  if (!serialized) {
    throw new TypeError(`${label} must be JSON-serializable.`);
  }
  if (requirePostgresJsonbText) {
    if (!normalizedValue || typeof normalizedValue !== 'object'
        || Array.isArray(normalizedValue)) {
      throw new TypeError(`${label} must be JSON-serializable.`);
    }
    assertPostgresJsonStringsExpressible(normalizedValue, label);
  }
  return serialized;
}

function normalizeWrestlers(wrestlers: readonly BackstageWrestler[]): BackstageWrestler[] {
  if (!Array.isArray(wrestlers)) {
    throw new TypeError('wrestlers must be an array.');
  }

  const names = new Set<string>();
  const normalized = wrestlers.map((wrestler, index) => {
    if (!wrestler || typeof wrestler !== 'object') {
      throw new TypeError(`wrestlers[${index}] must be an object.`);
    }
    const name = normalizeRequiredString(wrestler.name, `wrestlers[${index}].name`, 120);
    if (!Number.isInteger(wrestler.overall) || wrestler.overall < 0 || wrestler.overall > 100) {
      throw new TypeError(`wrestlers[${index}].overall must be an integer from 0 to 100.`);
    }
    if (names.has(name)) {
      throw new TypeError(`wrestlers contains duplicate name: ${name}`);
    }
    names.add(name);
    return { name, overall: wrestler.overall };
  });

  return normalized.sort((left, right) => left.name.localeCompare(right.name));
}

function parseDate(value: TimestampValue, label: string): Date {
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${label} is not a valid timestamp.`);
  }
  return parsed;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new TypeError(`${label} is not valid JSON.`);
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError(`${label} is not a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function toPoolReleaseError(cause: unknown, message: string): Error {
  return cause instanceof Error
    ? cause
    : new Error(message, { cause });
}

function mapWrestlerRow(row: BackstageWrestlerRow): BackstageWrestler {
  const overall = Number(row.overall);
  if (!Number.isInteger(overall) || overall < 0 || overall > 100) {
    throw new TypeError('Stored wrestler overall is invalid.');
  }
  return {
    name: row.name,
    overall,
    updatedAt: parseDate(row.updated_at, 'backstage_wrestlers.updated_at')
  };
}

function mapEventRow(row: BackstageEventRow): BackstageEventRecord {
  return {
    id: row.id,
    universeId: row.universe_id,
    data: parseJsonObject(row.data, 'backstage_events.data'),
    createdAt: parseDate(row.created_at, 'backstage_events.created_at')
  };
}

function mapStoryBeatRow(row: BackstageStoryBeatRow): BackstageStoryBeatRecord {
  if (
    row.serialized_data !== null
    && row.serialized_data !== undefined
    && typeof row.serialized_data !== 'string'
  ) {
    throw new TypeError(
      'backstage_story_beats.serialized_data is not a valid text component.'
    );
  }
  const storedPayload =
    typeof row.serialized_data === 'string'
      ? row.serialized_data
      : row.data;
  return {
    id: row.id,
    universeId: row.universe_id,
    data: parseJsonObject(
      storedPayload,
      typeof row.serialized_data === 'string'
        ? 'backstage_story_beats.serialized_data'
        : 'backstage_story_beats.data'
    ),
    createdAt: parseDate(row.created_at, 'backstage_story_beats.created_at')
  };
}

function mapStorylineRow(row: BackstageStorylineRow): BackstageStorylineRecord {
  return {
    id: row.id,
    universeId: row.universe_id,
    storyKey: row.story_key,
    storyline: row.storyline,
    createdAt: parseDate(row.created_at, 'backstage_storylines.created_at'),
    updatedAt: parseDate(row.updated_at, 'backstage_storylines.updated_at')
  };
}

export class PostgresBackstageBookerRepository {
  constructor(private readonly pool: Pool) {}

  private async assertUniverseScopeWriteActivated(
    client: PoolClient,
    universeId: string
  ): Promise<void> {
    if (universeId === LEGACY_BACKSTAGE_UNIVERSE_ID) {
      return;
    }

    const result = await client.query<BackstageUniverseScopeActivationRow>(
      `SELECT
         NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'backstage_wrestlers'::regclass
             AND conname = 'backstage_wrestlers_name_key'
         )
         AND NOT EXISTS (
           SELECT 1
           FROM pg_constraint
           WHERE conrelid = 'backstage_storylines'::regclass
             AND conname = 'backstage_storylines_story_key_key'
         ) AS activated`
    );
    const activated = result.rows[0]?.activated;
    if (typeof activated !== 'boolean') {
      throw new TypeError(
        'Backstage Booker universe-scope activation query returned an invalid result.'
      );
    }
    if (!activated) {
      throw new BackstageBookerUniverseScopeNotActivatedError();
    }
  }

  private async connect(operation: string): Promise<PoolClient> {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw new BackstageBookerRepositoryUnavailableError(operation, error);
    }
  }

  private async writeTransaction<T>(
    operation: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.connect(operation);
    let transactionStarted = false;
    let commitStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN');
      transactionStarted = true;
      const result = await callback(client);
      commitStarted = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (commitStarted) {
        releaseError = toPoolReleaseError(
          error,
          'Backstage Booker commit failed with a non-Error cause.'
        );
        throw new BackstageBookerCommitUnknownError(operation, error);
      }

      let rollbackCause: unknown;
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          rollbackCause = rollbackError;
          releaseError = toPoolReleaseError(
            rollbackError,
            'Backstage Booker rollback failed with a non-Error cause.'
          );
        }
      } else {
        releaseError = toPoolReleaseError(
          error,
          'Backstage Booker transaction start failed with a non-Error cause.'
        );
      }
      throw new BackstageBookerWriteError(operation, error, rollbackCause);
    } finally {
      client.release(releaseError);
    }
  }

  private async readSnapshot<T>(
    operation: string,
    callback: (client: PoolClient) => Promise<T>
  ): Promise<T> {
    const client = await this.connect(operation);
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionStarted = true;
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (transactionStarted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          releaseError = toPoolReleaseError(
            rollbackError,
            'Backstage Booker read rollback failed with a non-Error cause.'
          );
          // The read failure remains authoritative; this transaction cannot mutate state.
        }
      } else {
        releaseError = toPoolReleaseError(
          error,
          'Backstage Booker read transaction start failed with a non-Error cause.'
        );
      }
      throw new BackstageBookerRepositoryUnavailableError(operation, error);
    } finally {
      client.release(releaseError);
    }
  }

  async bookEvent(
    universeId: string,
    data: Record<string, unknown>,
    eventId = randomUUID()
  ): Promise<BackstageEventRecord> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedEventId = normalizeEventId(eventId);
    const serializedData = serializeJsonObject(data, 'event data', true);

    return this.writeTransaction('bookEvent', async client => {
      await this.assertUniverseScopeWriteActivated(client, normalizedUniverseId);
      const result = await client.query<BackstageEventRow>(
        `INSERT INTO backstage_events (id, universe_id, data, created_at)
         VALUES ($1::uuid, $2, $3::jsonb, NOW())
         RETURNING id, universe_id, data, created_at`,
        [normalizedEventId, normalizedUniverseId, serializedData]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('Backstage event insert returned no row.');
      }
      return mapEventRow(row);
    });
  }

  async updateRoster(
    universeId: string,
    wrestlers: readonly BackstageWrestler[]
  ): Promise<BackstageRosterMutationResult> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedWrestlers = normalizeWrestlers(wrestlers);

    return this.writeTransaction('updateRoster', async client => {
      await this.assertUniverseScopeWriteActivated(client, normalizedUniverseId);
      return applyBackstageRosterMutation(
        client,
        normalizedWrestlers,
        normalizedUniverseId
      );
    });
  }

  async trackStoryline(
    universeId: string,
    data: Record<string, unknown>
  ): Promise<BackstageStorylineMutationResult> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const serializedData = serializeJsonObject(data, 'story beat data');

    return this.writeTransaction('trackStoryline', async client => {
      return applyBackstageStorylineMutation(
        client,
        serializedData,
        normalizedUniverseId,
        () => this.assertUniverseScopeWriteActivated(client, normalizedUniverseId)
      );
    });
  }

  async saveStoryline(
    universeId: string,
    storyKey: string,
    storyline: string
  ): Promise<BackstageSavedStorylineMutationResult> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedStoryKey = normalizeRequiredString(storyKey, 'storyKey', 240);
    const normalizedStoryline = validateRequiredContent(storyline, 'storyline', 100_000);

    return this.writeTransaction('saveStoryline', async client => {
      await this.assertUniverseScopeWriteActivated(client, normalizedUniverseId);
      // Serialize the whole universe rather than one story key because the
      // convenience `storyline:latest` pointer orders mutations across keys.
      await client.query(
        'SELECT pg_advisory_xact_lock($1, hashtext($2))',
        [
          BACKSTAGE_SAVED_STORYLINE_ADVISORY_LOCK_NAMESPACE,
          `saved-storylines:${normalizedUniverseId}`
        ]
      );
      const revisionResult = await client.query<{ revision: string }>(
        'SELECT txid_current()::TEXT AS revision'
      );
      const revision = revisionResult.rows[0]?.revision;
      if (typeof revision !== 'string' || !/^[0-9]{1,20}$/u.test(revision)) {
        throw new Error('Backstage saved-storyline transaction revision was unavailable.');
      }
      const result = await client.query<BackstageStorylineRow>(
        `INSERT INTO backstage_storylines (
           universe_id,
           story_key,
           storyline,
           created_at,
           updated_at
         )
         VALUES ($1, $2, $3, clock_timestamp(), clock_timestamp())
         ON CONFLICT (universe_id, story_key)
         DO UPDATE SET storyline = EXCLUDED.storyline, updated_at = clock_timestamp()
         RETURNING id, universe_id, story_key, storyline, created_at, updated_at`,
        [normalizedUniverseId, normalizedStoryKey, normalizedStoryline]
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error('Backstage storyline upsert returned no row.');
      }
      return { ...mapStorylineRow(row), revision };
    });
  }

  async loadContext(universeId: string): Promise<BackstageContext> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    return this.readSnapshot('loadContext', async client => {
      const rosterResult = await client.query<BackstageWrestlerRow>(
        `SELECT name, overall, updated_at
         FROM backstage_wrestlers
         WHERE universe_id = $1
         ORDER BY updated_at DESC, name ASC
         LIMIT 25`,
        [normalizedUniverseId]
      );
      const eventsResult = await client.query<BackstageEventRow>(
        `SELECT id, universe_id, data, created_at
         FROM backstage_events
         WHERE universe_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT 5`,
        [normalizedUniverseId]
      );
      const beatsResult = await client.query<BackstageStoryBeatRow>(
        `SELECT id, universe_id, data, serialized_data, created_at
         FROM (
           SELECT
             id,
             universe_id,
             data,
             serialized_data,
             storage_sequence,
             created_at
           FROM backstage_story_beats
           WHERE universe_id = $1
             AND (
               serialized_data IS NOT NULL
               OR (
                 jsonb_typeof(data) = 'object'
                 AND created_at IS NOT NULL
                 AND isfinite(created_at)
                 AND octet_length(convert_to(data::TEXT, 'UTF8')) <= 16384
               )
           )
           ORDER BY
             (serialized_data IS NULL) ASC,
             CASE WHEN serialized_data IS NOT NULL THEN storage_sequence END DESC,
             CASE WHEN serialized_data IS NULL THEN created_at END DESC,
             id DESC
           LIMIT 5
         ) AS recent_beats
         ORDER BY
           (serialized_data IS NULL) ASC,
           CASE WHEN serialized_data IS NOT NULL THEN storage_sequence END ASC,
           CASE WHEN serialized_data IS NULL THEN created_at END ASC,
           id ASC`,
        [normalizedUniverseId]
      );
      const storylinesResult = await client.query<BackstageStorylineRow>(
        `SELECT id, universe_id, story_key, storyline, created_at, updated_at
         FROM backstage_storylines
         WHERE universe_id = $1
         ORDER BY updated_at DESC, id DESC
         LIMIT 5`,
        [normalizedUniverseId]
      );

      return {
        roster: rosterResult.rows.map(mapWrestlerRow),
        events: eventsResult.rows.map(mapEventRow),
        storyBeats: beatsResult.rows.map(mapStoryBeatRow),
        storylines: storylinesResult.rows.map(mapStorylineRow)
      };
    });
  }

  async loadRoster(universeId: string): Promise<BackstageWrestler[]> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    try {
      const result = await this.pool.query<BackstageWrestlerRow>(
        `SELECT name, overall, updated_at
         FROM backstage_wrestlers
         WHERE universe_id = $1
         ORDER BY name ASC`,
        [normalizedUniverseId]
      );
      return result.rows.map(mapWrestlerRow);
    } catch (error) {
      throw new BackstageBookerRepositoryUnavailableError('loadRoster', error);
    }
  }
}

export function createBackstageBookerRepository(
  pool: Pool
): PostgresBackstageBookerRepository {
  return new PostgresBackstageBookerRepository(pool);
}
