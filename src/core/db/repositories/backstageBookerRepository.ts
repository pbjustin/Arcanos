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
import {
  BACKSTAGE_SAVED_STORYLINE_TRANSFER_CODE_POINTS,
  BACKSTAGE_SAVED_STORYLINE_TRIM_START_CHARACTERS,
} from '@shared/backstage/backstageUniverseReadProjection.js';

export const LEGACY_BACKSTAGE_UNIVERSE_ID = 'legacy';
export const BACKSTAGE_UNIVERSE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const BACKSTAGE_SAVED_STORYLINE_ADVISORY_LOCK_NAMESPACE = 0x41524341;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/u;
const BACKSTAGE_CANON_CONTEXT_STORYLINE_LIMIT = 50;
const BACKSTAGE_CANON_CONTEXT_BEAT_LIMIT = 100;
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

export type BackstageCanonStorylineStatus =
  | 'draft'
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled';

export interface BackstageCanonStorylineUpsertInput {
  universeId: string;
  mutationId: string;
  requestFingerprint: string;
  storyKey: string;
  title: string;
  summary: string | null;
  status: BackstageCanonStorylineStatus;
  /** Zero creates a new thread; a positive value is an exact update CAS. */
  expectedVersion: number;
  participantNames: readonly string[];
}

export interface BackstageCanonBeatAppendInput {
  universeId: string;
  mutationId: string;
  requestFingerprint: string;
  storyKey: string;
  expectedVersion: number;
  kind: string;
  summary: string;
  occurredAt: Date | string;
  participantNames: readonly string[];
  eventId?: string | null;
  supersedesBeatId?: string | null;
  nextStatus?: BackstageCanonStorylineStatus;
}

export interface BackstageCanonStorylineRecord {
  id: string;
  universeId: string;
  storyKey: string;
  title: string;
  summary: string | null;
  status: BackstageCanonStorylineStatus;
  version: number;
  participantNames: string[];
  createdRevision: string;
  updatedRevision: string;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export type BackstageCanonStorylineSummaryRecord = Omit<
  BackstageCanonStorylineRecord,
  'participantNames'
>;

export interface BackstageCanonBeatRecord {
  id: string;
  universeId: string;
  storylineId: string;
  storyKey: string;
  sequence: number;
  kind: string;
  summary: string;
  occurredAt: Date;
  participantNames: string[];
  eventId: string | null;
  supersedesBeatId: string | null;
  revision: string;
  createdAt: Date;
}

export interface BackstageCanonStorylineMutationResult {
  mutationId: string;
  revision: string;
  replayed: boolean;
  storyline: BackstageCanonStorylineRecord;
}

export interface BackstageCanonBeatMutationResult {
  mutationId: string;
  revision: string;
  replayed: boolean;
  storyline: BackstageCanonStorylineRecord;
  beat: BackstageCanonBeatRecord;
}

export interface BackstageCanonContext {
  universeId: string;
  revision: string;
  storylines: BackstageCanonStorylineRecord[];
  /** Current projection: a beat disappears when another beat supersedes it. */
  activeBeats: BackstageCanonBeatRecord[];
}

export interface BackstageContext {
  roster: BackstageWrestler[];
  events: BackstageEventRecord[];
  storyBeats: BackstageStoryBeatRecord[];
  storylines: BackstageStorylineRecord[];
  canonContext: BackstageCanonContext;
}

export interface BackstageContextReadOptions {
  /** PostgreSQL statement timeout applied locally to the read-only transaction. */
  statementTimeoutMs?: number;
  /** Bound legacy scalar transfer for the authenticated universe-read projection. */
  universeReadProjection?: boolean;
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

interface BackstageCanonHeadRow {
  revision: string;
}

interface BackstageCanonRevisionReplayRow {
  operation: 'upsertStoryline' | 'appendCanonBeat';
  request_fingerprint: string;
  result: unknown;
}

interface BackstageCanonStorylineRow {
  id: string;
  universe_id: string;
  story_key: string;
  title: string;
  summary: string | null;
  status: string;
  version: number | string;
  participant_names?: unknown;
  created_revision: string;
  updated_revision: string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
  closed_at: TimestampValue | null;
}

interface BackstageCanonBeatRow {
  id: string;
  universe_id: string;
  storyline_id: string;
  story_key: string;
  sequence: number | string;
  kind: string;
  summary: string;
  occurred_at: TimestampValue;
  participant_names: unknown;
  event_id: string | null;
  supersedes_beat_id: string | null;
  universe_revision: string;
  created_at: TimestampValue;
}

interface BackstageCanonSequenceRow {
  sequence: number | string;
}

interface BackstageNotionAuthorityReadRow {
  authority: unknown;
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

/**
 * Prevent legacy PostgreSQL projections from escaping after the durable
 * authority head has switched a universe to Notion.
 */
export class BackstageBookerLegacyReadQuarantinedError extends Error {
  readonly code = 'BACKSTAGE_NOTION_AUTHORITY_READ_QUARANTINED';
  readonly universeId: string;

  constructor(universeId: string) {
    super(
      'Notion is authoritative for this Backstage universe; legacy PostgreSQL reads are quarantined.'
    );
    this.name = 'BackstageBookerLegacyReadQuarantinedError';
    this.universeId = universeId;
  }
}

export function isBackstageBookerLegacyReadQuarantinedError(
  value: unknown
): value is BackstageBookerLegacyReadQuarantinedError {
  return value instanceof BackstageBookerLegacyReadQuarantinedError;
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

export type BackstageCanonDomainErrorCode =
  | 'BACKSTAGE_STORYLINE_NOT_FOUND'
  | 'BACKSTAGE_STORYLINE_VERSION_CONFLICT'
  | 'BACKSTAGE_MUTATION_ID_CONFLICT'
  | 'BACKSTAGE_CANON_BEAT_CONFLICT'
  | 'BACKSTAGE_STORYLINE_TRANSITION_INVALID'
  | 'BACKSTAGE_STORYLINE_REFERENCE_INVALID';

const BACKSTAGE_CANON_DOMAIN_ERROR_STATUS: Readonly<
  Record<BackstageCanonDomainErrorCode, 404 | 409>
> = Object.freeze({
  BACKSTAGE_STORYLINE_NOT_FOUND: 404,
  BACKSTAGE_STORYLINE_VERSION_CONFLICT: 409,
  BACKSTAGE_MUTATION_ID_CONFLICT: 409,
  BACKSTAGE_CANON_BEAT_CONFLICT: 409,
  BACKSTAGE_STORYLINE_TRANSITION_INVALID: 409,
  BACKSTAGE_STORYLINE_REFERENCE_INVALID: 409
});

const BACKSTAGE_CANON_DOMAIN_ERROR_MESSAGE: Readonly<
  Record<BackstageCanonDomainErrorCode, string>
> = Object.freeze({
  BACKSTAGE_STORYLINE_NOT_FOUND: 'The requested Backstage storyline was not found.',
  BACKSTAGE_STORYLINE_VERSION_CONFLICT:
    'The Backstage storyline changed before this mutation could be applied.',
  BACKSTAGE_MUTATION_ID_CONFLICT:
    'The Backstage mutation identifier is already bound to different input.',
  BACKSTAGE_CANON_BEAT_CONFLICT:
    'The requested Backstage canon-beat mutation conflicts with current canon.',
  BACKSTAGE_STORYLINE_TRANSITION_INVALID:
    'The requested Backstage storyline lifecycle transition is not allowed.',
  BACKSTAGE_STORYLINE_REFERENCE_INVALID:
    'A referenced Backstage record does not exist in this universe.'
});

/** A bounded repository-domain conflict that is safe for an API boundary. */
export class BackstageCanonDomainError extends Error {
  readonly code: BackstageCanonDomainErrorCode;
  readonly httpStatus: 404 | 409;

  constructor(code: BackstageCanonDomainErrorCode) {
    super(BACKSTAGE_CANON_DOMAIN_ERROR_MESSAGE[code]);
    this.name = 'BackstageCanonDomainError';
    this.code = code;
    this.httpStatus = BACKSTAGE_CANON_DOMAIN_ERROR_STATUS[code];
  }
}

export function isBackstageCanonDomainError(
  value: unknown
): value is BackstageCanonDomainError {
  return value instanceof BackstageCanonDomainError;
}

export function resolveBackstageCanonDomainErrorHttpStatus(
  code: unknown
): 404 | 409 | null {
  if (
    typeof code !== 'string'
    || !Object.prototype.hasOwnProperty.call(BACKSTAGE_CANON_DOMAIN_ERROR_STATUS, code)
  ) {
    return null;
  }
  return BACKSTAGE_CANON_DOMAIN_ERROR_STATUS[code as BackstageCanonDomainErrorCode];
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

function validateNullableContent(
  value: string | null,
  label: string,
  maxLength: number
): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`${label} must be a string or null.`);
  }
  assertPostgresTextExpressible(value, label);
  if (!hasAtMostCodePoints(value, maxLength)) {
    throw new TypeError(`${label} must contain at most ${maxLength} characters.`);
  }
  return value;
}

function normalizeUuid(value: string, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a UUID.`);
  }
  return value.toLowerCase();
}

function normalizeRequestFingerprint(value: string): string {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) {
    throw new TypeError('requestFingerprint must be a lowercase SHA-256 digest.');
  }
  return value;
}

function normalizeExpectedVersion(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new TypeError('expectedVersion must be an integer from 0 through 2147483647.');
  }
  return value;
}

const BACKSTAGE_CANON_STORYLINE_STATUSES = new Set<BackstageCanonStorylineStatus>([
  'draft',
  'active',
  'paused',
  'completed',
  'cancelled'
]);

function normalizeCanonStorylineStatus(value: unknown): BackstageCanonStorylineStatus {
  if (
    typeof value !== 'string'
    || !BACKSTAGE_CANON_STORYLINE_STATUSES.has(value as BackstageCanonStorylineStatus)
  ) {
    throw new TypeError('status must be a valid Backstage storyline lifecycle state.');
  }
  return value as BackstageCanonStorylineStatus;
}

const BACKSTAGE_CANON_STATUS_TRANSITIONS: Readonly<
  Record<BackstageCanonStorylineStatus, ReadonlySet<BackstageCanonStorylineStatus>>
> = Object.freeze({
  draft: new Set<BackstageCanonStorylineStatus>(['draft', 'active', 'cancelled']),
  active: new Set<BackstageCanonStorylineStatus>([
    'active',
    'paused',
    'completed',
    'cancelled'
  ]),
  paused: new Set<BackstageCanonStorylineStatus>([
    'paused',
    'active',
    'completed',
    'cancelled'
  ]),
  completed: new Set<BackstageCanonStorylineStatus>(),
  cancelled: new Set<BackstageCanonStorylineStatus>()
});

function assertCanonStorylineTransition(
  currentStatus: BackstageCanonStorylineStatus,
  nextStatus: BackstageCanonStorylineStatus
): void {
  if (!BACKSTAGE_CANON_STATUS_TRANSITIONS[currentStatus].has(nextStatus)) {
    throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_TRANSITION_INVALID');
  }
}

function normalizeParticipantNames(
  value: readonly string[],
  label = 'participantNames'
): string[] {
  if (!Array.isArray(value) || value.length > 50) {
    throw new TypeError(`${label} must be an array containing at most 50 names.`);
  }
  const seen = new Set<string>();
  const normalized = value.map((name, index) => {
    const normalizedName = normalizeRequiredString(name, `${label}[${index}]`, 120);
    if (seen.has(normalizedName)) {
      throw new TypeError(`${label} contains a duplicate wrestler name: ${normalizedName}`);
    }
    seen.add(normalizedName);
    return normalizedName;
  });
  // PostgreSQL renders jsonb array separators as `, ` while JSON.stringify
  // emits `,`; account for those spaces so validation exactly matches the
  // database's participant_names::TEXT byte check.
  const postgresJsonbTextBytes = Buffer.byteLength(
    JSON.stringify(normalized),
    'utf8'
  ) + Math.max(0, normalized.length - 1);
  if (postgresJsonbTextBytes > 16_384) {
    throw new TypeError(`${label} exceeds its UTF-8 storage contract.`);
  }
  return normalized;
}

function normalizeOccurredAt(value: Date | string): Date {
  if (!(value instanceof Date) && typeof value !== 'string') {
    throw new TypeError('occurredAt must be a valid timestamp.');
  }
  const parsed = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError('occurredAt must be a valid timestamp.');
  }
  return parsed;
}

function parsePostgresRevision(value: unknown, label: string, allowZero = false): string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,18})$/u.test(value)) {
    throw new TypeError(`${label} is not a valid PostgreSQL revision.`);
  }
  const parsed = BigInt(value);
  if (parsed > 9_223_372_036_854_775_807n || (!allowZero && parsed < 1n)) {
    throw new TypeError(`${label} is not a valid PostgreSQL revision.`);
  }
  return value;
}

function parsePositiveInteger(value: unknown, label: string): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^[1-9]\d*$/u.test(value)
      ? Number(value)
      : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new TypeError(`${label} is not a valid positive integer.`);
  }
  return parsed;
}

function parseJsonStringArray(value: unknown, label: string): string[] {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed) as unknown;
    } catch {
      throw new TypeError(`${label} is not valid JSON.`);
    }
  }
  if (!Array.isArray(parsed)) {
    throw new TypeError(`${label} is not a JSON array.`);
  }
  return normalizeParticipantNames(parsed as string[], label);
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

function mapCanonStorylineRow(
  row: BackstageCanonStorylineRow,
  participantNames = row.participant_names === undefined
    ? []
    : parseJsonStringArray(
        row.participant_names,
        'backstage_storyline_threads.participant_names'
      )
): BackstageCanonStorylineRecord {
  const version = parsePositiveInteger(
    row.version,
    'backstage_storyline_threads.version'
  );
  return {
    id: normalizeUuid(row.id, 'backstage_storyline_threads.id'),
    universeId: normalizeUniverseId(row.universe_id),
    storyKey: normalizeRequiredString(
      row.story_key,
      'backstage_storyline_threads.story_key',
      240
    ),
    title: normalizeRequiredString(row.title, 'backstage_storyline_threads.title', 240),
    summary: validateNullableContent(
      row.summary,
      'backstage_storyline_threads.summary',
      10_000
    ),
    status: normalizeCanonStorylineStatus(row.status),
    version,
    participantNames: [...participantNames],
    createdRevision: parsePostgresRevision(
      row.created_revision,
      'backstage_storyline_threads.created_revision'
    ),
    updatedRevision: parsePostgresRevision(
      row.updated_revision,
      'backstage_storyline_threads.updated_revision'
    ),
    createdAt: parseDate(row.created_at, 'backstage_storyline_threads.created_at'),
    updatedAt: parseDate(row.updated_at, 'backstage_storyline_threads.updated_at'),
    closedAt: row.closed_at === null
      ? null
      : parseDate(row.closed_at, 'backstage_storyline_threads.closed_at')
  };
}

function mapCanonBeatRow(row: BackstageCanonBeatRow): BackstageCanonBeatRecord {
  return {
    id: normalizeUuid(row.id, 'backstage_storyline_canon_beats.id'),
    universeId: normalizeUniverseId(row.universe_id),
    storylineId: normalizeUuid(
      row.storyline_id,
      'backstage_storyline_canon_beats.storyline_id'
    ),
    storyKey: normalizeRequiredString(
      row.story_key,
      'backstage_storyline_threads.story_key',
      240
    ),
    sequence: parsePositiveInteger(
      row.sequence,
      'backstage_storyline_canon_beats.sequence'
    ),
    kind: normalizeRequiredString(row.kind, 'backstage_storyline_canon_beats.kind', 64),
    summary: validateRequiredContent(
      row.summary,
      'backstage_storyline_canon_beats.summary',
      10_000
    ),
    occurredAt: parseDate(
      row.occurred_at,
      'backstage_storyline_canon_beats.occurred_at'
    ),
    participantNames: parseJsonStringArray(
      row.participant_names,
      'backstage_storyline_canon_beats.participant_names'
    ),
    eventId: row.event_id === null
      ? null
      : normalizeUuid(row.event_id, 'backstage_storyline_canon_beats.event_id'),
    supersedesBeatId: row.supersedes_beat_id === null
      ? null
      : normalizeUuid(
          row.supersedes_beat_id,
          'backstage_storyline_canon_beats.supersedes_beat_id'
        ),
    revision: parsePostgresRevision(
      row.universe_revision,
      'backstage_storyline_canon_beats.universe_revision'
    ),
    createdAt: parseDate(row.created_at, 'backstage_storyline_canon_beats.created_at')
  };
}

function parseCanonStorylineResult(value: unknown): BackstageCanonStorylineRecord {
  const record = parseJsonObject(value, 'backstage_canon_revisions.result.storyline');
  return mapCanonStorylineRow({
    id: record.id as string,
    universe_id: record.universeId as string,
    story_key: record.storyKey as string,
    title: record.title as string,
    summary: record.summary as string | null,
    status: record.status as string,
    version: record.version as number,
    participant_names: record.participantNames,
    created_revision: record.createdRevision as string,
    updated_revision: record.updatedRevision as string,
    created_at: record.createdAt as string,
    updated_at: record.updatedAt as string,
    closed_at: (record.closedAt ?? null) as string | null
  });
}

function parseCanonBeatResult(value: unknown): BackstageCanonBeatRecord {
  const record = parseJsonObject(value, 'backstage_canon_revisions.result.beat');
  return mapCanonBeatRow({
    id: record.id as string,
    universe_id: record.universeId as string,
    storyline_id: record.storylineId as string,
    story_key: record.storyKey as string,
    sequence: record.sequence as number,
    kind: record.kind as string,
    summary: record.summary as string,
    occurred_at: record.occurredAt as string,
    participant_names: record.participantNames,
    event_id: (record.eventId ?? null) as string | null,
    supersedes_beat_id: (record.supersedesBeatId ?? null) as string | null,
    universe_revision: record.revision as string,
    created_at: record.createdAt as string
  });
}

function parseCanonStorylineMutationReplay(
  value: unknown
): BackstageCanonStorylineMutationResult {
  const record = parseJsonObject(value, 'backstage_canon_revisions.result');
  return {
    mutationId: normalizeUuid(record.mutationId as string, 'result.mutationId'),
    revision: parsePostgresRevision(record.revision, 'result.revision'),
    replayed: true,
    storyline: parseCanonStorylineResult(record.storyline)
  };
}

function parseCanonBeatMutationReplay(value: unknown): BackstageCanonBeatMutationResult {
  const record = parseJsonObject(value, 'backstage_canon_revisions.result');
  return {
    mutationId: normalizeUuid(record.mutationId as string, 'result.mutationId'),
    revision: parsePostgresRevision(record.revision, 'result.revision'),
    replayed: true,
    storyline: parseCanonStorylineResult(record.storyline),
    beat: parseCanonBeatResult(record.beat)
  };
}

export class PostgresBackstageBookerRepository {
  constructor(private readonly pool: Pool) {}

  private async assertLegacyReadAllowed(
    client: PoolClient,
    universeId: string
  ): Promise<void> {
    await client.query(
      'LOCK TABLE backstage_notion_universe_heads IN ACCESS SHARE MODE'
    );
    const result = await client.query<BackstageNotionAuthorityReadRow>(
      `SELECT authority
       FROM backstage_notion_universe_heads
       WHERE universe_id = $1`,
      [universeId]
    );
    const row = result.rows[0];
    if (!row) {
      return;
    }
    if (row.authority === 'notion') {
      throw new BackstageBookerLegacyReadQuarantinedError(universeId);
    }
    if (row.authority !== 'postgres') {
      throw new TypeError(
        'Backstage Notion authority head returned an unsupported authority.'
      );
    }
  }

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

  private async lockCanonHead(
    client: PoolClient,
    universeId: string
  ): Promise<string> {
    await client.query(
      `INSERT INTO backstage_canon_heads (universe_id)
       VALUES ($1)
       ON CONFLICT (universe_id) DO NOTHING`,
      [universeId]
    );
    const result = await client.query<BackstageCanonHeadRow>(
      `SELECT revision::TEXT AS revision
       FROM backstage_canon_heads
       WHERE universe_id = $1
       FOR UPDATE`,
      [universeId]
    );
    const revision = result.rows[0]?.revision;
    return parsePostgresRevision(
      revision,
      'backstage_canon_heads.revision',
      true
    );
  }

  private async loadCanonMutationReplay(
    client: PoolClient,
    universeId: string,
    mutationId: string,
    operation: 'upsertStoryline' | 'appendCanonBeat',
    requestFingerprint: string
  ): Promise<unknown | null> {
    const result = await client.query<BackstageCanonRevisionReplayRow>(
      `SELECT operation, request_fingerprint, result
       FROM backstage_canon_revisions
       WHERE universe_id = $1
         AND mutation_id = $2::UUID`,
      [universeId, mutationId]
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    if (
      row.operation !== operation
      || row.request_fingerprint !== requestFingerprint
    ) {
      throw new BackstageCanonDomainError('BACKSTAGE_MUTATION_ID_CONFLICT');
    }
    return row.result;
  }

  private async bumpCanonRevision(
    client: PoolClient,
    universeId: string
  ): Promise<string> {
    const result = await client.query<BackstageCanonHeadRow>(
      `UPDATE backstage_canon_heads
       SET revision = revision + 1, updated_at = clock_timestamp()
       WHERE universe_id = $1
         AND revision < 9223372036854775807
       RETURNING revision::TEXT AS revision`,
      [universeId]
    );
    const revision = result.rows[0]?.revision;
    if (revision === undefined) {
      throw new Error('Backstage canon revision could not be advanced.');
    }
    return parsePostgresRevision(revision, 'backstage_canon_heads.revision');
  }

  private async insertCanonRevision(
    client: PoolClient,
    universeId: string,
    revision: string,
    mutationId: string,
    operation: 'upsertStoryline' | 'appendCanonBeat',
    requestFingerprint: string,
    result: BackstageCanonStorylineMutationResult | BackstageCanonBeatMutationResult
  ): Promise<void> {
    const serializedResult = serializeJsonObject(
      result as unknown as Record<string, unknown>,
      'canon mutation result',
      true
    );
    if (Buffer.byteLength(serializedResult, 'utf8') > 262_144) {
      throw new Error('Backstage canon mutation result exceeds its storage contract.');
    }
    await client.query(
      `INSERT INTO backstage_canon_revisions (
         universe_id,
         revision,
         mutation_id,
         operation,
         request_fingerprint,
         result,
         created_at
       )
       VALUES ($1, $2::BIGINT, $3::UUID, $4, $5, $6::JSONB, clock_timestamp())`,
      [
        universeId,
        revision,
        mutationId,
        operation,
        requestFingerprint,
        serializedResult
      ]
    );
  }

  private async validateCanonDeferredConstraints(client: PoolClient): Promise<void> {
    // Resolve Phase-2 lineage defects while COMMIT has not started. Otherwise a
    // deterministic missing revision could be mislabeled as an unknown commit.
    await client.query(
      `SET CONSTRAINTS
         fk_backstage_storyline_threads_created_revision,
         fk_backstage_storyline_threads_updated_revision,
         fk_backstage_storyline_participants_revision,
         fk_backstage_storyline_canon_beats_revision
       IMMEDIATE`
    );
  }

  private async assertCanonRosterReferences(
    client: PoolClient,
    universeId: string,
    participantNames: readonly string[]
  ): Promise<void> {
    if (participantNames.length === 0) {
      return;
    }
    const result = await client.query<{ name: string }>(
      `SELECT name
       FROM backstage_wrestlers
       WHERE universe_id = $1
         AND name = ANY($2::TEXT[])
       FOR KEY SHARE`,
      [universeId, participantNames]
    );
    const found = new Set(result.rows.map(row => row.name));
    if (
      found.size !== participantNames.length
      || participantNames.some(name => !found.has(name))
    ) {
      throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_REFERENCE_INVALID');
    }
  }

  private async loadCanonStorylineParticipantNames(
    client: PoolClient,
    universeId: string,
    storylineId: string
  ): Promise<string[]> {
    const result = await client.query<{ wrestler_name: string }>(
      `SELECT wrestler_name
       FROM backstage_storyline_participants
       WHERE universe_id = $1
         AND storyline_id = $2::UUID
       ORDER BY sort_order ASC, wrestler_name ASC`,
      [universeId, storylineId]
    );
    return normalizeParticipantNames(
      result.rows.map(row => row.wrestler_name),
      'backstage_storyline_participants.wrestler_name'
    );
  }

  private async loadCanonContextFromClient(
    client: PoolClient,
    universeId: string
  ): Promise<BackstageCanonContext> {
    const headResult = await client.query<BackstageCanonHeadRow>(
      `SELECT revision::TEXT AS revision
       FROM backstage_canon_heads
       WHERE universe_id = $1`,
      [universeId]
    );
    const revision = headResult.rows[0]
      ? parsePostgresRevision(
          headResult.rows[0].revision,
          'backstage_canon_heads.revision',
          true
        )
      : '0';

    const storylineResult = await client.query<BackstageCanonStorylineRow>(
      `SELECT
         thread.id,
         thread.universe_id,
         thread.story_key,
         thread.title,
         thread.summary,
         thread.status,
         thread.version,
         thread.created_revision::TEXT AS created_revision,
         thread.updated_revision::TEXT AS updated_revision,
         thread.created_at,
         thread.updated_at,
         thread.closed_at,
         COALESCE(
           jsonb_agg(participant.wrestler_name ORDER BY participant.sort_order)
             FILTER (WHERE participant.wrestler_name IS NOT NULL),
           '[]'::JSONB
         ) AS participant_names
       FROM (
         SELECT *
         FROM backstage_storyline_threads
         WHERE universe_id = $1
         ORDER BY updated_at DESC, id DESC
         LIMIT $2
       ) AS thread
       LEFT JOIN backstage_storyline_participants AS participant
         ON participant.universe_id = thread.universe_id
        AND participant.storyline_id = thread.id
       GROUP BY
         thread.id,
         thread.universe_id,
         thread.story_key,
         thread.title,
         thread.summary,
         thread.status,
         thread.version,
         thread.created_revision,
         thread.updated_revision,
         thread.created_at,
         thread.updated_at,
         thread.closed_at
       ORDER BY thread.updated_at DESC, thread.id DESC`,
      [universeId, BACKSTAGE_CANON_CONTEXT_STORYLINE_LIMIT]
    );

    const beatResult = await client.query<BackstageCanonBeatRow>(
      `SELECT recent.*
       FROM (
         SELECT
           beat.id,
           beat.universe_id,
           beat.storyline_id,
           thread.story_key,
           beat.sequence,
           beat.kind,
           beat.summary,
           beat.occurred_at,
           beat.participant_names,
           beat.event_id,
           beat.supersedes_beat_id,
           beat.universe_revision::TEXT AS universe_revision,
           beat.created_at
         FROM backstage_storyline_canon_beats AS beat
         INNER JOIN backstage_storyline_threads AS thread
           ON thread.universe_id = beat.universe_id
          AND thread.id = beat.storyline_id
         WHERE beat.universe_id = $1
           AND NOT EXISTS (
             SELECT 1
             FROM backstage_storyline_canon_beats AS replacement
             WHERE replacement.universe_id = beat.universe_id
               AND replacement.supersedes_beat_id = beat.id
           )
         ORDER BY beat.occurred_at DESC, beat.sequence DESC, beat.id DESC
         LIMIT $2
       ) AS recent
       ORDER BY recent.occurred_at ASC, recent.sequence ASC, recent.id ASC`,
      [universeId, BACKSTAGE_CANON_CONTEXT_BEAT_LIMIT]
    );

    return {
      universeId,
      revision,
      storylines: storylineResult.rows.map(row => mapCanonStorylineRow(row)),
      activeBeats: beatResult.rows.map(mapCanonBeatRow)
    };
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
      if (isBackstageCanonDomainError(error) && rollbackCause === undefined) {
        throw error;
      }
      throw new BackstageBookerWriteError(operation, error, rollbackCause);
    } finally {
      client.release(releaseError);
    }
  }

  private async readSnapshot<T>(
    operation: string,
    callback: (client: PoolClient) => Promise<T>,
    options: BackstageContextReadOptions = {}
  ): Promise<T> {
    const statementTimeoutMs = options.statementTimeoutMs;
    if (
      statementTimeoutMs !== undefined
      && (!Number.isSafeInteger(statementTimeoutMs)
        || statementTimeoutMs < 1
        || statementTimeoutMs > 44_000)
    ) {
      throw new TypeError('statementTimeoutMs must be an integer from 1 through 44000.');
    }
    const client = await this.connect(operation);
    let transactionStarted = false;
    let releaseError: Error | undefined;
    try {
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      transactionStarted = true;
      if (statementTimeoutMs !== undefined) {
        await client.query(`SET LOCAL statement_timeout = '${statementTimeoutMs}ms'`);
      }
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
      if (isBackstageBookerLegacyReadQuarantinedError(error)) {
        throw error;
      }
      throw new BackstageBookerRepositoryUnavailableError(operation, error);
    } finally {
      client.release(releaseError);
    }
  }

  async upsertStoryline(
    input: BackstageCanonStorylineUpsertInput
  ): Promise<BackstageCanonStorylineMutationResult> {
    const universeId = normalizeUniverseId(input.universeId);
    const mutationId = normalizeUuid(input.mutationId, 'mutationId');
    const requestFingerprint = normalizeRequestFingerprint(input.requestFingerprint);
    const storyKey = normalizeRequiredString(input.storyKey, 'storyKey', 240);
    const title = normalizeRequiredString(input.title, 'title', 240);
    const summary = validateNullableContent(input.summary, 'summary', 10_000);
    const status = normalizeCanonStorylineStatus(input.status);
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    const participantNames = normalizeParticipantNames(input.participantNames);
    if (expectedVersion === 0 && status !== 'draft' && status !== 'active') {
      throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_TRANSITION_INVALID');
    }
    if (status === 'completed') {
      // Completion is evidence-bearing: only an appended payoff/resolution beat
      // may close a storyline, never a projection-only upsert.
      throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_TRANSITION_INVALID');
    }

    return this.writeTransaction('upsertStoryline', async client => {
      await this.assertUniverseScopeWriteActivated(client, universeId);
      await this.lockCanonHead(client, universeId);
      const replayValue = await this.loadCanonMutationReplay(
        client,
        universeId,
        mutationId,
        'upsertStoryline',
        requestFingerprint
      );
      if (replayValue !== null) {
        const replay = parseCanonStorylineMutationReplay(replayValue);
        if (
          replay.mutationId !== mutationId
          || replay.storyline.universeId !== universeId
        ) {
          throw new TypeError('Stored Backstage storyline replay is scoped incorrectly.');
        }
        return replay;
      }

      const existingResult = await client.query<BackstageCanonStorylineRow>(
        `SELECT
           id,
           universe_id,
           story_key,
           title,
           summary,
           status,
           version,
           created_revision::TEXT AS created_revision,
           updated_revision::TEXT AS updated_revision,
           created_at,
           updated_at,
           closed_at
         FROM backstage_storyline_threads
         WHERE universe_id = $1
           AND story_key = $2
         FOR UPDATE`,
        [universeId, storyKey]
      );
      const existingRow = existingResult.rows[0];
      if (expectedVersion === 0) {
        if (existingRow) {
          throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT');
        }
      } else {
        if (!existingRow) {
          throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_NOT_FOUND');
        }
        const currentVersion = parsePositiveInteger(
          existingRow.version,
          'backstage_storyline_threads.version'
        );
        if (currentVersion !== expectedVersion) {
          throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT');
        }
        assertCanonStorylineTransition(
          normalizeCanonStorylineStatus(existingRow.status),
          status
        );
      }

      await this.assertCanonRosterReferences(client, universeId, participantNames);
      const revision = await this.bumpCanonRevision(client, universeId);
      let storylineRow: BackstageCanonStorylineRow | undefined;

      if (expectedVersion === 0) {
        const storylineId = randomUUID();
        const inserted = await client.query<BackstageCanonStorylineRow>(
          `INSERT INTO backstage_storyline_threads (
             id,
             universe_id,
             story_key,
             title,
             summary,
             status,
             version,
             created_revision,
             updated_revision,
             created_at,
             updated_at,
             closed_at
           )
           VALUES (
             $1::UUID,
             $2,
             $3,
             $4,
             $5,
             $6,
             1,
             $7::BIGINT,
             $7::BIGINT,
             clock_timestamp(),
             clock_timestamp(),
             NULL
           )
           RETURNING
             id,
             universe_id,
             story_key,
             title,
             summary,
             status,
             version,
             created_revision::TEXT AS created_revision,
             updated_revision::TEXT AS updated_revision,
             created_at,
             updated_at,
             closed_at`,
          [storylineId, universeId, storyKey, title, summary, status, revision]
        );
        storylineRow = inserted.rows[0];
      } else {
        const updated = await client.query<BackstageCanonStorylineRow>(
          `UPDATE backstage_storyline_threads
           SET
             title = $3,
             summary = $4,
             status = $5,
             version = version + 1,
             updated_revision = $6::BIGINT,
             updated_at = clock_timestamp(),
             closed_at = CASE
               WHEN $5 IN ('completed', 'cancelled')
                 THEN COALESCE(closed_at, clock_timestamp())
               ELSE NULL
             END
           WHERE universe_id = $1
             AND story_key = $2
             AND version = $7
             AND version < 2147483647
           RETURNING
             id,
             universe_id,
             story_key,
             title,
             summary,
             status,
             version,
             created_revision::TEXT AS created_revision,
             updated_revision::TEXT AS updated_revision,
             created_at,
             updated_at,
             closed_at`,
          [
            universeId,
            storyKey,
            title,
            summary,
            status,
            revision,
            expectedVersion
          ]
        );
        storylineRow = updated.rows[0];
        if (!storylineRow) {
          throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT');
        }
      }

      if (!storylineRow) {
        throw new Error('Backstage storyline upsert returned no row.');
      }

      await client.query(
        `DELETE FROM backstage_storyline_participants
         WHERE universe_id = $1
           AND storyline_id = $2::UUID`,
        [universeId, storylineRow.id]
      );
      if (participantNames.length > 0) {
        await client.query(
          `INSERT INTO backstage_storyline_participants (
             universe_id,
             storyline_id,
             wrestler_name,
             sort_order,
             created_revision,
             created_at
           )
           SELECT
             $1,
             $2::UUID,
             participant.wrestler_name,
             (participant.ordinality - 1)::INTEGER,
             $4::BIGINT,
             clock_timestamp()
           FROM UNNEST($3::TEXT[]) WITH ORDINALITY
             AS participant(wrestler_name, ordinality)`,
          [universeId, storylineRow.id, participantNames, revision]
        );
      }

      const storyline = mapCanonStorylineRow(storylineRow, participantNames);
      const result: BackstageCanonStorylineMutationResult = {
        mutationId,
        revision,
        replayed: false,
        storyline
      };
      await this.insertCanonRevision(
        client,
        universeId,
        revision,
        mutationId,
        'upsertStoryline',
        requestFingerprint,
        result
      );
      await this.validateCanonDeferredConstraints(client);
      return result;
    });
  }

  async appendCanonBeat(
    input: BackstageCanonBeatAppendInput
  ): Promise<BackstageCanonBeatMutationResult> {
    const universeId = normalizeUniverseId(input.universeId);
    const mutationId = normalizeUuid(input.mutationId, 'mutationId');
    const requestFingerprint = normalizeRequestFingerprint(input.requestFingerprint);
    const storyKey = normalizeRequiredString(input.storyKey, 'storyKey', 240);
    const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
    if (expectedVersion === 0) {
      throw new TypeError('expectedVersion must be positive when appending a canon beat.');
    }
    const kind = normalizeRequiredString(input.kind, 'kind', 64);
    const summary = validateRequiredContent(input.summary, 'summary', 10_000);
    const occurredAt = normalizeOccurredAt(input.occurredAt);
    const participantNames = normalizeParticipantNames(input.participantNames);
    const eventId = input.eventId == null
      ? null
      : normalizeUuid(input.eventId, 'eventId');
    const supersedesBeatId = input.supersedesBeatId == null
      ? null
      : normalizeUuid(input.supersedesBeatId, 'supersedesBeatId');
    const requestedNextStatus = input.nextStatus === undefined
      ? undefined
      : normalizeCanonStorylineStatus(input.nextStatus);

    return this.writeTransaction('appendCanonBeat', async client => {
      await this.assertUniverseScopeWriteActivated(client, universeId);
      await this.lockCanonHead(client, universeId);
      const replayValue = await this.loadCanonMutationReplay(
        client,
        universeId,
        mutationId,
        'appendCanonBeat',
        requestFingerprint
      );
      if (replayValue !== null) {
        const replay = parseCanonBeatMutationReplay(replayValue);
        if (
          replay.mutationId !== mutationId
          || replay.storyline.universeId !== universeId
          || replay.beat.universeId !== universeId
        ) {
          throw new TypeError('Stored Backstage canon-beat replay is scoped incorrectly.');
        }
        return replay;
      }

      const storylineResult = await client.query<BackstageCanonStorylineRow>(
        `SELECT
           id,
           universe_id,
           story_key,
           title,
           summary,
           status,
           version,
           created_revision::TEXT AS created_revision,
           updated_revision::TEXT AS updated_revision,
           created_at,
           updated_at,
           closed_at
         FROM backstage_storyline_threads
         WHERE universe_id = $1
           AND story_key = $2
         FOR UPDATE`,
        [universeId, storyKey]
      );
      const currentStoryline = storylineResult.rows[0];
      if (!currentStoryline) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_NOT_FOUND');
      }
      const currentVersion = parsePositiveInteger(
        currentStoryline.version,
        'backstage_storyline_threads.version'
      );
      if (currentVersion !== expectedVersion) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT');
      }
      const currentStatus = normalizeCanonStorylineStatus(currentStoryline.status);
      if (
        currentStatus !== 'active'
        && currentStatus !== 'paused'
        && !(currentStatus === 'draft' && requestedNextStatus === 'active')
      ) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_TRANSITION_INVALID');
      }
      const nextStatus = requestedNextStatus ?? currentStatus;
      assertCanonStorylineTransition(currentStatus, nextStatus);
      if (
        nextStatus === 'completed'
        && kind !== 'payoff'
        && kind !== 'resolution'
      ) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_TRANSITION_INVALID');
      }

      await this.assertCanonRosterReferences(client, universeId, participantNames);
      const storylineParticipantNames = await this.loadCanonStorylineParticipantNames(
        client,
        universeId,
        currentStoryline.id
      );
      const storylineParticipantSet = new Set(storylineParticipantNames);
      if (participantNames.some(name => !storylineParticipantSet.has(name))) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_REFERENCE_INVALID');
      }

      if (eventId !== null) {
        const eventResult = await client.query<{ id: string }>(
          `SELECT id
           FROM backstage_events
           WHERE universe_id = $1
             AND id = $2::UUID
           FOR KEY SHARE`,
          [universeId, eventId]
        );
        if (!eventResult.rows[0]) {
          throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_REFERENCE_INVALID');
        }
      }

      if (supersedesBeatId !== null) {
        const supersededResult = await client.query<{
          id: string;
          already_superseded: boolean;
        }>(
          `SELECT
             beat.id,
             EXISTS (
               SELECT 1
               FROM backstage_storyline_canon_beats AS replacement
               WHERE replacement.universe_id = beat.universe_id
                 AND replacement.supersedes_beat_id = beat.id
             ) AS already_superseded
           FROM backstage_storyline_canon_beats AS beat
           WHERE beat.universe_id = $1
             AND beat.storyline_id = $2::UUID
             AND beat.id = $3::UUID
           FOR KEY SHARE`,
          [universeId, currentStoryline.id, supersedesBeatId]
        );
        const superseded = supersededResult.rows[0];
        if (!superseded || superseded.already_superseded) {
          throw new BackstageCanonDomainError('BACKSTAGE_CANON_BEAT_CONFLICT');
        }
      }

      const sequenceResult = await client.query<BackstageCanonSequenceRow>(
        `SELECT (COALESCE(MAX(sequence), 0)::BIGINT + 1)::TEXT AS sequence
         FROM backstage_storyline_canon_beats
         WHERE universe_id = $1
           AND storyline_id = $2::UUID`,
        [universeId, currentStoryline.id]
      );
      const sequence = parsePositiveInteger(
        sequenceResult.rows[0]?.sequence,
        'backstage_storyline_canon_beats.sequence'
      );
      const revision = await this.bumpCanonRevision(client, universeId);

      const updatedStorylineResult = await client.query<BackstageCanonStorylineRow>(
        `UPDATE backstage_storyline_threads
         SET
           status = $3,
           version = version + 1,
           updated_revision = $4::BIGINT,
           updated_at = clock_timestamp(),
           closed_at = CASE
             WHEN $3 IN ('completed', 'cancelled')
               THEN COALESCE(closed_at, clock_timestamp())
             ELSE NULL
           END
         WHERE universe_id = $1
           AND story_key = $2
           AND version = $5
           AND version < 2147483647
         RETURNING
           id,
           universe_id,
           story_key,
           title,
           summary,
           status,
           version,
           created_revision::TEXT AS created_revision,
           updated_revision::TEXT AS updated_revision,
           created_at,
           updated_at,
           closed_at`,
        [universeId, storyKey, nextStatus, revision, expectedVersion]
      );
      const updatedStorylineRow = updatedStorylineResult.rows[0];
      if (!updatedStorylineRow) {
        throw new BackstageCanonDomainError('BACKSTAGE_STORYLINE_VERSION_CONFLICT');
      }

      const beatId = randomUUID();
      const serializedParticipantNames = JSON.stringify(participantNames);
      const beatResult = await client.query<BackstageCanonBeatRow>(
        `INSERT INTO backstage_storyline_canon_beats (
           id,
           universe_id,
           storyline_id,
           sequence,
           kind,
           summary,
           occurred_at,
           participant_names,
           event_id,
           supersedes_beat_id,
           universe_revision,
           created_at
         )
         VALUES (
           $1::UUID,
           $2,
           $3::UUID,
           $4,
           $5,
           $6,
           $7::TIMESTAMPTZ,
           $8::JSONB,
           $9::UUID,
           $10::UUID,
           $11::BIGINT,
           clock_timestamp()
         )
         RETURNING
           id,
           universe_id,
           storyline_id,
           $12::TEXT AS story_key,
           sequence,
           kind,
           summary,
           occurred_at,
           participant_names,
           event_id,
           supersedes_beat_id,
           universe_revision::TEXT AS universe_revision,
           created_at`,
        [
          beatId,
          universeId,
          currentStoryline.id,
          sequence,
          kind,
          summary,
          occurredAt.toISOString(),
          serializedParticipantNames,
          eventId,
          supersedesBeatId,
          revision,
          storyKey
        ]
      );
      const beatRow = beatResult.rows[0];
      if (!beatRow) {
        throw new Error('Backstage canon-beat insert returned no row.');
      }

      const storyline = mapCanonStorylineRow(
        updatedStorylineRow,
        storylineParticipantNames
      );
      const beat = mapCanonBeatRow(beatRow);
      const result: BackstageCanonBeatMutationResult = {
        mutationId,
        revision,
        replayed: false,
        storyline,
        beat
      };
      await this.insertCanonRevision(
        client,
        universeId,
        revision,
        mutationId,
        'appendCanonBeat',
        requestFingerprint,
        result
      );
      await this.validateCanonDeferredConstraints(client);
      return result;
    });
  }

  async loadCanonContext(universeId: string): Promise<BackstageCanonContext> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    return this.readSnapshot('loadCanonContext', async client => {
      await this.assertLegacyReadAllowed(client, normalizedUniverseId);
      return this.loadCanonContextFromClient(client, normalizedUniverseId);
    });
  }

  async loadCanonStorylineSummary(
    universeId: string,
    storyKey: string,
    options: BackstageContextReadOptions = {}
  ): Promise<BackstageCanonStorylineSummaryRecord | null> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const normalizedStoryKey = normalizeRequiredString(storyKey, 'storyKey', 240);
    return this.readSnapshot('loadCanonStorylineSummary', async client => {
      await this.assertLegacyReadAllowed(client, normalizedUniverseId);
      const result = await client.query<BackstageCanonStorylineRow>(
        `SELECT
           id,
           universe_id,
           story_key,
           title,
           summary,
           status,
           version,
           created_revision::TEXT AS created_revision,
           updated_revision::TEXT AS updated_revision,
           created_at,
           updated_at,
           closed_at
         FROM backstage_storyline_threads
         WHERE universe_id = $1
           AND story_key = $2`,
        [normalizedUniverseId, normalizedStoryKey]
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      const { participantNames, ...storyline } = mapCanonStorylineRow(row);
      void participantNames;
      return storyline;
    }, options);
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

  async loadContext(
    universeId: string,
    options: BackstageContextReadOptions = {}
  ): Promise<BackstageContext> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    const universeReadProjection = options.universeReadProjection === true;
    const rosterNameSelection = universeReadProjection
      ? 'LEFT(BTRIM(name), 121) AS name'
      : 'name';
    const eventDataSelection = universeReadProjection
      ? `jsonb_strip_nulls(jsonb_build_object(
           'name', CASE WHEN jsonb_typeof(data -> 'name') = 'string'
             THEN LEFT(BTRIM(data ->> 'name'), 241) END,
           'title', CASE WHEN jsonb_typeof(data -> 'title') = 'string'
             THEN LEFT(BTRIM(data ->> 'title'), 241) END,
           'eventName', CASE WHEN jsonb_typeof(data -> 'eventName') = 'string'
             THEN LEFT(BTRIM(data ->> 'eventName'), 241) END,
           'showName', CASE WHEN jsonb_typeof(data -> 'showName') = 'string'
             THEN LEFT(BTRIM(data ->> 'showName'), 241) END,
           'summary', CASE WHEN jsonb_typeof(data -> 'summary') = 'string'
             THEN LEFT(BTRIM(data ->> 'summary'), 501) END,
           'description', CASE WHEN jsonb_typeof(data -> 'description') = 'string'
             THEN LEFT(BTRIM(data ->> 'description'), 501) END,
           'result', CASE WHEN jsonb_typeof(data -> 'result') = 'string'
             THEN LEFT(BTRIM(data ->> 'result'), 501) END,
           'notes', CASE WHEN jsonb_typeof(data -> 'notes') = 'string'
             THEN LEFT(BTRIM(data ->> 'notes'), 501) END
         )) AS data`
      : 'data';
    const storyBeatDataSelection = universeReadProjection
      ? "CASE WHEN serialized_data IS NOT NULL THEN '{}'::jsonb ELSE data END AS data"
      : 'data';
    const storyBeatEligibility = universeReadProjection
      ? `(serialized_data IS NOT NULL
           AND octet_length(convert_to(serialized_data, 'UTF8')) <= 16384)
         OR (
           serialized_data IS NULL
           AND jsonb_typeof(data) = 'object'
           AND created_at IS NOT NULL
           AND isfinite(created_at)
           AND octet_length(convert_to(data::TEXT, 'UTF8')) <= 16384
         )`
      : `serialized_data IS NOT NULL
         OR (
           jsonb_typeof(data) = 'object'
           AND created_at IS NOT NULL
           AND isfinite(created_at)
           AND octet_length(convert_to(data::TEXT, 'UTF8')) <= 16384
         )`;
    const savedStorylineSelection = universeReadProjection
      ? `LEFT(BTRIM(story_key), 241) AS story_key,
         LEFT(LTRIM(storyline, $2), $3) AS storyline`
      : 'story_key, storyline';
    const savedStorylineValues = universeReadProjection
      ? [
          normalizedUniverseId,
          BACKSTAGE_SAVED_STORYLINE_TRIM_START_CHARACTERS,
          BACKSTAGE_SAVED_STORYLINE_TRANSFER_CODE_POINTS,
        ]
      : [normalizedUniverseId];
    return this.readSnapshot('loadContext', async client => {
      await this.assertLegacyReadAllowed(client, normalizedUniverseId);
      const rosterResult = await client.query<BackstageWrestlerRow>(
        `SELECT ${rosterNameSelection}, overall, updated_at
         FROM backstage_wrestlers
         WHERE universe_id = $1
         ORDER BY backstage_wrestlers.updated_at DESC, backstage_wrestlers.name ASC
         LIMIT 25`,
        [normalizedUniverseId]
      );
      const eventsResult = await client.query<BackstageEventRow>(
        `SELECT id, universe_id, ${eventDataSelection}, created_at
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
             ${storyBeatDataSelection},
             serialized_data,
             storage_sequence,
             created_at
           FROM backstage_story_beats
            WHERE universe_id = $1
              AND (
               ${storyBeatEligibility}
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
        `SELECT id, universe_id, ${savedStorylineSelection}, created_at, updated_at
         FROM backstage_storylines
         WHERE universe_id = $1
         ORDER BY updated_at DESC, id DESC
         LIMIT 5`,
        savedStorylineValues
      );
      const canonContext = await this.loadCanonContextFromClient(
        client,
        normalizedUniverseId
      );

      return {
        roster: rosterResult.rows.map(mapWrestlerRow),
        events: eventsResult.rows.map(mapEventRow),
        storyBeats: beatsResult.rows.map(mapStoryBeatRow),
        storylines: storylinesResult.rows.map(mapStorylineRow),
        canonContext
      };
    }, options);
  }

  async loadRoster(universeId: string): Promise<BackstageWrestler[]> {
    const normalizedUniverseId = normalizeUniverseId(universeId);
    return this.readSnapshot('loadRoster', async client => {
      await this.assertLegacyReadAllowed(client, normalizedUniverseId);
      const result = await client.query<BackstageWrestlerRow>(
        `SELECT name, overall, updated_at
         FROM backstage_wrestlers
         WHERE universe_id = $1
         ORDER BY name ASC`,
        [normalizedUniverseId]
      );
      return result.rows.map(mapWrestlerRow);
    });
  }
}

export function createBackstageBookerRepository(
  pool: Pool
): PostgresBackstageBookerRepository {
  return new PostgresBackstageBookerRepository(pool);
}
