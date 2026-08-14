import { createHash } from 'crypto';
import {
  DEFAULT_BACKSTAGE_UNIVERSE_ID,
  validateBackstageBookerActionPayload,
  type BackstageBookerAction,
  type BackstageBookerActionInputMap,
  type ValidationIssue
} from '@arcanos/protocol';
import { BACKSTAGE_BOOK_EVENT_MAX_BYTES } from '@shared/backstage/backstageEvent.js';
import { parseBackstageRosterPayload } from '@shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BackstageStorylineValidationError,
  parseBackstageStorylinePayload
} from '@shared/backstage/backstageStoryline.js';

export const BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS = '__arcanosBackstageExplicitPayloadFields';
export const BACKSTAGE_FLATTENED_PAYLOAD_FLAG = '__arcanosBackstageFlattenedPayload';

const RESERVED_BACKSTAGE_PROVENANCE_FIELDS = Object.freeze([
  BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS,
  BACKSTAGE_FLATTENED_PAYLOAD_FLAG,
]);
const trustedBackstagePayloadProvenance = Symbol('trustedBackstagePayloadProvenance');

export type BackstageBookerMutationIngress =
  | 'canonical-gpt'
  | 'direct'
  | 'dispatch'
  | 'legacy';

type BackstageBookerMutationAction =
  | 'appendCanonBeat'
  | 'bookEvent'
  | 'saveStoryline'
  | 'trackStoryline'
  | 'upsertStoryline'
  | 'updateRoster';

const TRANSPORT_ONLY_FIELDS = new Set([
  '__arcanosExecutionMode',
  '__arcanosGptId',
  '__arcanosRequestedAction',
  '__arcanosSourceEndpoint',
  '__arcanosSuppressPromptDebugTrace',
  '__arcanosSuppressTimeoutFallback',
  'action',
  'answerMode',
  'audit',
  'context',
  'enableAudit',
  'enableHrc',
  'gptVersion',
  'hrc',
  'maxWords',
  'max_words',
  'message',
  'messages',
  'mode',
  'overrideAuditSafe',
  'sessionId',
  'userInput',
  'content',
  'text',
  'query'
]);

export function buildBackstageUniverseMemoryKey(
  universeId: string,
  suffix: 'roster:latest' | 'storybeats:latest' | 'storyline:latest'
): string {
  return `backstage-universe:${universeId}:${suffix}`;
}

export function buildBackstageStorylineByKeyMemoryKey(
  universeId: string,
  storylineKey: string
): string {
  const digest = createHash('sha256')
    .update(storylineKey.trim(), 'utf8')
    .digest('hex');
  return `backstage-universe:${universeId}:storyline:by-key:${digest}`;
}

export class BackstageBookerContractError extends Error {
  readonly action: BackstageBookerAction;
  readonly issues: ValidationIssue[];

  constructor(action: BackstageBookerAction, issues: ValidationIssue[]) {
    super(`Invalid Backstage Booker ${action} payload.`);
    this.name = 'BackstageBookerContractError';
    this.action = action;
    this.issues = issues;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stripTransportFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => !key.startsWith('__arcanos') && !TRANSPORT_ONLY_FIELDS.has(key)
    )
  );
}

function stripInternalFields(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !key.startsWith('__arcanos'))
  );
}

type TrustedBackstagePayloadProvenance = Readonly<{
  explicitFields: ReadonlySet<string> | null;
  flattened: boolean;
}>;

type TrustedBackstagePayloadRecord = Record<string, unknown> & {
  [trustedBackstagePayloadProvenance]?: TrustedBackstagePayloadProvenance;
};

function readTrustedBackstagePayloadProvenance(
  record: Record<string, unknown>
): TrustedBackstagePayloadProvenance | null {
  return (record as TrustedBackstagePayloadRecord)[trustedBackstagePayloadProvenance] ?? null;
}

function markTrustedBackstagePayloadProvenance(
  record: Record<string, unknown>,
  provenance: TrustedBackstagePayloadProvenance
): void {
  // Keep provenance invisible to JSON, equality/fingerprint enumeration, and caller-controlled
  // string keys. Dispatcher copy stages explicitly transfer this trusted descriptor.
  Object.defineProperty(record, trustedBackstagePayloadProvenance, {
    configurable: true,
    enumerable: false,
    value: provenance,
    writable: false,
  });
}

export function markBackstageBookerExplicitPayload(
  payload: Record<string, unknown>,
  explicitFields: readonly string[]
): void {
  markTrustedBackstagePayloadProvenance(payload, Object.freeze({
    explicitFields: new Set(explicitFields),
    flattened: false,
  }));
}

export function markBackstageBookerFlattenedPayload(
  payload: Record<string, unknown>
): void {
  markTrustedBackstagePayloadProvenance(payload, Object.freeze({
    explicitFields: null,
    flattened: true,
  }));
}

export function copyBackstageBookerPayloadProvenance(
  source: unknown,
  target: unknown
): void {
  const sourceRecord = asRecord(source);
  const targetRecord = asRecord(target);
  if (!sourceRecord || !targetRecord) {
    return;
  }
  const provenance = readTrustedBackstagePayloadProvenance(sourceRecord);
  if (provenance) {
    markTrustedBackstagePayloadProvenance(targetRecord, provenance);
  }
}

function assertNoReservedBackstageProvenanceFields(
  action: BackstageBookerAction,
  payload: unknown
): void {
  const record = asRecord(payload);
  const reservedKey = record
    ? RESERVED_BACKSTAGE_PROVENANCE_FIELDS.find(
        key => Object.prototype.hasOwnProperty.call(record, key)
      )
    : undefined;
  if (!reservedKey) {
    return;
  }
  throw new BackstageBookerContractError(action, [
    {
      instancePath: `/${reservedKey}`,
      message: 'Reserved internal Backstage payload provenance fields are not allowed.',
    },
  ]);
}

function markSchemaDrivenPayload<TAction extends BackstageBookerAction>(
  action: TAction,
  payload: BackstageBookerActionInputMap[TAction]
): BackstageBookerActionInputMap[TAction] {
  const wrapperKey = action === 'bookEvent'
    ? 'event'
    : action === 'trackStoryline'
      ? 'beat'
      : null;
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }

  markBackstageBookerExplicitPayload(record, wrapperKey ? [wrapperKey] : []);
  return payload;
}

function hasSchemaDrivenCanonicalIntent(
  action: BackstageBookerAction,
  payload: unknown
): boolean {
  const record = asRecord(payload);
  if (!record) {
    return action !== 'bookEvent'
      && action !== 'trackStoryline'
      && action !== 'updateRoster';
  }
  if (Object.prototype.hasOwnProperty.call(record, 'universeId')) {
    return true;
  }

  switch (action) {
    case 'bookEvent':
      return asRecord(record.event) !== null;
    case 'trackStoryline':
      return asRecord(record.beat) !== null;
    case 'updateRoster':
      return Object.prototype.hasOwnProperty.call(record, 'wrestlers');
    case 'simulateMatch':
    case 'generateBooking':
    case 'generateBookingWithHRC':
    case 'saveStoryline':
    case 'upsertStoryline':
    case 'appendCanonBeat':
      return true;
  }
}

export const BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE = 'BACKSTAGE_CANON_UNAVAILABLE';
export const BACKSTAGE_CANON_UNAVAILABLE_ERROR_MESSAGE =
  'Backstage canon persistence is temporarily unavailable.';
export const BACKSTAGE_CANON_COMMIT_UNKNOWN_JOB_REUSE_REASON =
  'backstage_canon_commit_outcome_unknown';

/**
 * Identify the truthful receipt returned when PostgreSQL commit acknowledgement
 * is lost for a Phase 2 canon mutation. Async jobs retain this receipt for
 * polling, but must not reuse it as an idempotent completed result because a
 * subsequent request with the same mutationId is how the durable outcome is
 * reconciled.
 */
export function isBackstageCanonCommitOutcomeUnknown(
  action: unknown,
  result: unknown
): boolean {
  if (action !== 'upsertStoryline' && action !== 'appendCanonBeat') {
    return false;
  }

  const record = asRecord(result);
  const persistence = asRecord(record?.persistence);
  return record?.applied === null
    && record.universeRevision === null
    && record.storyline === null
    && persistence?.status === 'unknown'
    && persistence.durable === null
    && persistence.backend === 'postgresql'
    && persistence.degraded === true
    && persistence.reason === 'commit_outcome_unknown';
}

/** Represent a classified pre-commit canon outage without exposing repository details. */
export class BackstageCanonUnavailableError extends Error {
  readonly code = BACKSTAGE_CANON_UNAVAILABLE_ERROR_CODE;
  readonly httpStatus = 503;
  readonly retryable = true;
  readonly operation: 'upsertStoryline' | 'appendCanonBeat';

  constructor(
    operation: 'upsertStoryline' | 'appendCanonBeat',
    cause?: unknown
  ) {
    super(
      BACKSTAGE_CANON_UNAVAILABLE_ERROR_MESSAGE,
      cause === undefined ? undefined : { cause }
    );
    this.name = 'BackstageCanonUnavailableError';
    this.operation = operation;
  }
}

export function isBackstageCanonUnavailableError(
  value: unknown
): value is BackstageCanonUnavailableError {
  return value instanceof BackstageCanonUnavailableError;
}

function sanitizeOpenPayloadRecord(record: Record<string, unknown>): Record<string, unknown> {
  const provenance = readTrustedBackstagePayloadProvenance(record);
  const explicitFields = provenance?.explicitFields ?? null;
  const flattenedPayload = provenance?.flattened === true;
  const internalStripped = stripInternalFields(record);

  if (flattenedPayload) {
    return Object.fromEntries(
      Object.entries(internalStripped).filter(
        ([key]) => key !== 'prompt' && !TRANSPORT_ONLY_FIELDS.has(key)
      )
    );
  }
  if (explicitFields) {
    return Object.fromEntries(
      Object.entries(internalStripped).filter(([key]) => (
        key === 'universeId'
        || explicitFields.has(key)
      ))
    );
  }

  // Direct module invocations are domain payloads. Only reserved internal metadata is removed;
  // ordinary names such as action/context/mode/hrc/content remain valid event or beat fields.
  return internalStripped;
}

function resolveSchemaDrivenPayloadCandidate(
  action: BackstageBookerAction,
  payload: unknown
): unknown {
  const record = asRecord(payload);
  if (!record) {
    return payload;
  }

  const hasDispatchProvenance = readTrustedBackstagePayloadProvenance(record) !== null;
  if (action === 'bookEvent' || action === 'trackStoryline') {
    return hasDispatchProvenance
      ? sanitizeOpenPayloadRecord(record)
      : stripInternalFields(record);
  }
  return hasDispatchProvenance
    ? stripTransportFields(record)
    : stripInternalFields(record);
}

function resolveUniverseId(record: Record<string, unknown> | null): unknown {
  return record && Object.prototype.hasOwnProperty.call(record, 'universeId')
    ? record.universeId
    : DEFAULT_BACKSTAGE_UNIVERSE_ID;
}

function withoutUniverseId(record: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...record };
  delete copy.universeId;
  return copy;
}

function normalizeLegacyOpenPayload(
  sanitizedRecord: Record<string, unknown>
): Record<string, unknown> {
  return withoutUniverseId(sanitizedRecord);
}

function isCanonicalOpenPayloadWrapper(
  record: Record<string, unknown>,
  rawRecord: Record<string, unknown>,
  wrapperKey: 'event' | 'beat'
): boolean {
  // `event` and `beat` were already valid top-level domain field names before
  // the canonical wrapper existed. An explicit universe scope or the
  // dispatcher's explicit-payload provenance is the unambiguous signal that
  // the caller intends the wrapped contract shape.
  const explicitFields = readTrustedBackstagePayloadProvenance(rawRecord)?.explicitFields ?? null;
  if (
    !Object.prototype.hasOwnProperty.call(record, 'universeId')
    && !explicitFields?.has(wrapperKey)
  ) {
    return false;
  }
  if (!Object.prototype.hasOwnProperty.call(record, wrapperKey)) {
    return false;
  }
  if (!asRecord(record[wrapperKey])) {
    return false;
  }
  return Object.keys(record).every(
    key => key === 'universeId' || key === wrapperKey
  );
}

function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value);
  }
  if (typeof value !== 'object') {
    return false;
  }
  if (ancestors.has(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    return false;
  }

  ancestors.add(value);
  const valid = Array.isArray(value)
    ? value.every(entry => isJsonValue(entry, ancestors))
    : Object.values(value as Record<string, unknown>)
        .every(entry => isJsonValue(entry, ancestors));
  ancestors.delete(value);
  return valid;
}

function assertOpenPayloadJson(action: BackstageBookerAction, value: unknown): string {
  if (!isJsonValue(value)) {
    throw new BackstageBookerContractError(action, [
      { instancePath: '/', message: 'Payload must contain only finite JSON values.' }
    ]);
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new BackstageBookerContractError(action, [
      { instancePath: '/', message: 'Payload must be JSON serializable.' }
    ]);
  }

  if (typeof serialized !== 'string') {
    throw new BackstageBookerContractError(action, [
      { instancePath: '/', message: 'Payload must be JSON serializable.' }
    ]);
  }

  return serialized;
}

function assertStorylinePayloadSize(value: unknown): void {
  const serialized = assertOpenPayloadJson('trackStoryline', value);
  if (Buffer.byteLength(serialized, 'utf8') > BACKSTAGE_STORYLINE_MAX_BYTES) {
    throw new BackstageStorylineValidationError(
      `Storyline beat payload must not exceed ${BACKSTAGE_STORYLINE_MAX_BYTES} bytes of serialized UTF-8 JSON.`
    );
  }
}

function assertBookEventPayloadSize(value: unknown): void {
  const serialized = assertOpenPayloadJson('bookEvent', value);
  if (Buffer.byteLength(serialized, 'utf8') > BACKSTAGE_BOOK_EVENT_MAX_BYTES) {
    throw new BackstageBookerContractError('bookEvent', [{
      instancePath: '/event',
      message: `Event payload must not exceed ${BACKSTAGE_BOOK_EVENT_MAX_BYTES} bytes of serialized UTF-8 JSON.`
    }]);
  }
}

function normalizeCandidate(action: BackstageBookerAction, payload: unknown): unknown {
  const rawRecord = asRecord(payload);
  const sanitizedRecord = rawRecord
    ? action === 'bookEvent' || action === 'trackStoryline'
      ? sanitizeOpenPayloadRecord(rawRecord)
      : stripTransportFields(rawRecord)
    : null;

  switch (action) {
    case 'bookEvent': {
      if (!sanitizedRecord || !rawRecord) {
        return payload;
      }
      const universeId = resolveUniverseId(rawRecord);
      const hasEventWrapper = isCanonicalOpenPayloadWrapper(
        sanitizedRecord,
        rawRecord,
        'event'
      );
      const event = hasEventWrapper
        ? sanitizedRecord.event
        : normalizeLegacyOpenPayload(sanitizedRecord);
      assertBookEventPayloadSize(event);
      return hasEventWrapper
        ? { ...sanitizedRecord, universeId }
        : { universeId, event };
    }
    case 'updateRoster': {
      if (Array.isArray(payload)) {
        return {
          universeId: DEFAULT_BACKSTAGE_UNIVERSE_ID,
          wrestlers: parseBackstageRosterPayload(payload)
        };
      }
      if (!sanitizedRecord) {
        parseBackstageRosterPayload(payload);
        return payload;
      }
      const universeId = resolveUniverseId(sanitizedRecord);
      if (Object.prototype.hasOwnProperty.call(sanitizedRecord, 'wrestlers')) {
        return {
          ...sanitizedRecord,
          universeId,
          wrestlers: parseBackstageRosterPayload(sanitizedRecord.wrestlers)
        };
      }
      const candidate: Record<string, unknown> = {
        ...sanitizedRecord,
        universeId,
        wrestlers: sanitizedRecord.roster
      };
      delete candidate.roster;
      candidate.wrestlers = parseBackstageRosterPayload(candidate.wrestlers);
      return candidate;
    }
    case 'trackStoryline': {
      if (!sanitizedRecord || !rawRecord) {
        parseBackstageStorylinePayload(payload);
        return payload;
      }
      const universeId = resolveUniverseId(rawRecord);
      const hasBeatWrapper = isCanonicalOpenPayloadWrapper(
        sanitizedRecord,
        rawRecord,
        'beat'
      );
      const beat = hasBeatWrapper
        ? sanitizedRecord.beat
        : normalizeLegacyOpenPayload(sanitizedRecord);
      const normalizedBeat = parseBackstageStorylinePayload(beat);
      assertStorylinePayloadSize(normalizedBeat);
      return hasBeatWrapper
        ? { ...sanitizedRecord, beat: normalizedBeat, universeId }
        : { universeId, beat: normalizedBeat };
    }
    case 'simulateMatch': {
      if (!sanitizedRecord) {
        return payload;
      }
      return { ...sanitizedRecord, universeId: resolveUniverseId(sanitizedRecord) };
    }
    case 'generateBooking':
    case 'generateBookingWithHRC': {
      if (!sanitizedRecord) {
        return payload;
      }
      return { ...sanitizedRecord, universeId: resolveUniverseId(sanitizedRecord) };
    }
    case 'saveStoryline': {
      if (!sanitizedRecord) {
        return payload;
      }
      return { ...sanitizedRecord, universeId: resolveUniverseId(sanitizedRecord) };
    }
    case 'upsertStoryline':
    case 'appendCanonBeat':
      // Phase 2 canon mutations deliberately have no implicit legacy universe.
      // Their closed schemas require the caller to choose the durable scope explicitly.
      return sanitizedRecord ?? payload;
  }
}

function canonContractIssue(
  action: 'upsertStoryline' | 'appendCanonBeat',
  instancePath: string,
  message: string
): never {
  throw new BackstageBookerContractError(action, [{ instancePath, message }]);
}

function normalizeCanonUuid(
  action: 'upsertStoryline' | 'appendCanonBeat',
  value: string,
  instancePath: string
): string {
  const normalized = value.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
    .test(normalized)) {
    return canonContractIssue(action, instancePath, 'Value must be a UUID.');
  }
  return normalized;
}

function normalizeCanonParticipants(
  action: 'upsertStoryline' | 'appendCanonBeat',
  names: readonly string[],
  instancePath: string
): string[] {
  const normalized = names.map(name => name.trim());
  // Match PostgreSQL jsonb text rendering, which inserts one space after each
  // comma. Reject this closed-contract storage bound before repository effects.
  const postgresJsonbTextBytes = Buffer.byteLength(
    JSON.stringify(normalized),
    'utf8'
  ) + Math.max(0, normalized.length - 1);
  if (postgresJsonbTextBytes > 16_384) {
    return canonContractIssue(
      action,
      instancePath,
      'participantNames must fit the 16384-byte canon storage contract.'
    );
  }
  return normalized;
}

const CANON_UTC_TIMESTAMP_PATTERN =
  /^(?!0000-)[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](?:\.[0-9]{1,9})?Z$/u;

function normalizeCanonTimestamp(value: string): string {
  if (!CANON_UTC_TIMESTAMP_PATTERN.test(value)) {
    return canonContractIssue(
      'appendCanonBeat',
      '/beat/occurredAt',
      'occurredAt must be a supported UTC timestamp from year 0001 through 9999.'
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return canonContractIssue(
      'appendCanonBeat',
      '/beat/occurredAt',
      'occurredAt must be a valid UTC timestamp.'
    );
  }
  const normalized = parsed.toISOString();
  if (normalized.slice(0, 19) !== value.slice(0, 19)) {
    return canonContractIssue(
      'appendCanonBeat',
      '/beat/occurredAt',
      'occurredAt must identify a valid UTC calendar timestamp.'
    );
  }
  return normalized;
}

function normalizeCanonMutationCandidate(
  action: BackstageBookerAction,
  candidate: unknown
): unknown {
  if (action === 'upsertStoryline') {
    const input = candidate as BackstageBookerActionInputMap['upsertStoryline'];
    const normalized: BackstageBookerActionInputMap['upsertStoryline'] = {
      universeId: input.universeId.trim(),
      mutationId: normalizeCanonUuid(action, input.mutationId, '/mutationId'),
      expectedVersion: input.expectedVersion,
      storyline: {
        key: input.storyline.key.trim(),
        title: input.storyline.title.trim(),
        summary: input.storyline.summary === null ? null : input.storyline.summary.trim(),
        status: input.storyline.status,
        participantNames: normalizeCanonParticipants(
          action,
          input.storyline.participantNames,
          '/storyline/participantNames'
        )
      }
    };
    if (
      normalized.expectedVersion === 0
      && normalized.storyline.status !== 'draft'
      && normalized.storyline.status !== 'active'
    ) {
      return canonContractIssue(
        action,
        '/storyline/status',
        'A new storyline must start in draft or active status.'
      );
    }
    return normalized;
  }

  if (action === 'appendCanonBeat') {
    const input = candidate as BackstageBookerActionInputMap['appendCanonBeat'];
    const normalized: BackstageBookerActionInputMap['appendCanonBeat'] = {
      universeId: input.universeId.trim(),
      mutationId: normalizeCanonUuid(action, input.mutationId, '/mutationId'),
      storylineKey: input.storylineKey.trim(),
      expectedVersion: input.expectedVersion,
      beat: {
        kind: input.beat.kind.trim(),
        summary: input.beat.summary.trim(),
        occurredAt: normalizeCanonTimestamp(input.beat.occurredAt),
        participantNames: normalizeCanonParticipants(
          action,
          input.beat.participantNames,
          '/beat/participantNames'
        ),
        ...(input.beat.eventId === undefined
          ? {}
          : { eventId: normalizeCanonUuid(action, input.beat.eventId, '/beat/eventId') }),
        ...(input.beat.supersedesBeatId === undefined
          ? {}
          : {
              supersedesBeatId: normalizeCanonUuid(
                action,
                input.beat.supersedesBeatId,
                '/beat/supersedesBeatId'
              )
            })
      },
      ...(input.nextStatus === undefined ? {} : { nextStatus: input.nextStatus })
    };
    if (
      normalized.nextStatus === 'completed'
      && normalized.beat.kind !== 'payoff'
      && normalized.beat.kind !== 'resolution'
    ) {
      return canonContractIssue(
        action,
        '/beat/kind',
        'Completing an active or paused storyline requires a payoff or resolution beat.'
      );
    }
    return normalized;
  }

  return candidate;
}

/**
 * Normalize legacy Booker payloads to the v1 module-action contract and validate before effects.
 */
export function normalizeBackstageBookerActionPayload<TAction extends BackstageBookerAction>(
  action: TAction,
  payload: unknown
): BackstageBookerActionInputMap[TAction] {
  const schemaCandidate = normalizeCandidate(action, payload);
  if (action === 'upsertStoryline' || action === 'appendCanonBeat') {
    const schemaValidation = validateBackstageBookerActionPayload(action, schemaCandidate);
    if (!schemaValidation.ok) {
      throw new BackstageBookerContractError(action, schemaValidation.issues);
    }
  }
  const candidate = normalizeCanonMutationCandidate(action, schemaCandidate);
  const validation = validateBackstageBookerActionPayload(action, candidate);
  if (!validation.ok) {
    throw new BackstageBookerContractError(action, validation.issues);
  }
  if (action === 'simulateMatch') {
    const match = (candidate as BackstageBookerActionInputMap['simulateMatch']).match;
    const wrestler1 = match.wrestler1.trim();
    const wrestler2 = match.wrestler2.trim();
    if (wrestler1 === wrestler2) {
      throw new BackstageBookerContractError(action, [
        {
          instancePath: '/match/wrestler2',
          message: 'Match participants must be different wrestlers.'
        }
      ]);
    }
  }
  return candidate as BackstageBookerActionInputMap[TAction];
}

/**
 * Normalize payloads received from schema-advertised module surfaces.
 *
 * Normalized values carry trusted symbol provenance so the module adapter can distinguish a
 * canonical `{ beat: {...} }` wrapper from the identical legacy domain record without changing
 * JSON, confirmation fingerprints, or direct legacy module behavior.
 */
export function normalizeBackstageBookerSchemaDrivenActionPayload<
  TAction extends BackstageBookerAction
>(
  action: TAction,
  payload: unknown
): BackstageBookerActionInputMap[TAction] {
  assertNoReservedBackstageProvenanceFields(action, payload);
  const schemaCandidate = resolveSchemaDrivenPayloadCandidate(action, payload);
  const canonicalValidation = validateBackstageBookerActionPayload(action, schemaCandidate);
  let normalized: BackstageBookerActionInputMap[TAction];

  if (canonicalValidation.ok) {
    const record = asRecord(schemaCandidate);
    const canonicalCandidate = record
      ? markSchemaDrivenPayload(
          action,
          { ...record } as unknown as BackstageBookerActionInputMap[TAction]
        )
      : schemaCandidate;
    normalized = normalizeBackstageBookerActionPayload(action, canonicalCandidate);
  } else if (hasSchemaDrivenCanonicalIntent(action, schemaCandidate)) {
    throw new BackstageBookerContractError(action, canonicalValidation.issues);
  } else {
    // Compatibility inputs remain accepted on schema-driven surfaces, but are normalized to the
    // canonical wrapper before module dispatch. Validate the raw open record before sanitizing it
    // so exotic prototypes cannot become durable plain-object data.
    if (action === 'bookEvent') {
      assertOpenPayloadJson(action, payload);
    } else if (action === 'trackStoryline') {
      parseBackstageStorylinePayload(payload);
    }
    normalized = normalizeBackstageBookerActionPayload(action, payload);
  }

  return markSchemaDrivenPayload(action, normalized);
}

function hasSchemaDrivenOpenPayloadProvenance(
  action: 'bookEvent' | 'trackStoryline',
  payload: unknown
): boolean {
  const record = asRecord(payload);
  if (!record) {
    return false;
  }
  const wrapperKey = action === 'bookEvent' ? 'event' : 'beat';
  const explicitFields = readTrustedBackstagePayloadProvenance(record)?.explicitFields ?? null;
  if (!explicitFields?.has(wrapperKey)) {
    return false;
  }
  return asRecord(record[wrapperKey]) !== null
    || Array.from(explicitFields).every(
      key => key === 'universeId' || key === wrapperKey
    );
}

/** Select the schema-driven adapter only when the calling surface supplied canonical provenance. */
export function normalizeBackstageBookerModuleActionPayload<
  TAction extends BackstageBookerAction
>(
  action: TAction,
  payload: unknown
): BackstageBookerActionInputMap[TAction] {
  if (action === 'bookEvent' || action === 'trackStoryline') {
    return hasSchemaDrivenOpenPayloadProvenance(action, payload)
      ? normalizeBackstageBookerSchemaDrivenActionPayload(action, payload)
      : normalizeBackstageBookerActionPayload(action, payload);
  }

  const record = asRecord(payload);
  const hasSchemaDrivenProvenance = record !== null
    && readTrustedBackstagePayloadProvenance(record) !== null;
  return hasSchemaDrivenProvenance
    ? normalizeBackstageBookerSchemaDrivenActionPayload(action, payload)
    : normalizeBackstageBookerActionPayload(action, payload);
}

/**
 * Resolve the mutation payload that an HTTP ingress will pass to the Booker action adapter.
 * The returned canonical value is safe to use for both confirmation fingerprints and
 * validation-before-effects; callers may keep their original transport envelope unchanged.
 */
export function normalizeBackstageBookerIngressMutationPayload<
  TAction extends BackstageBookerMutationAction
>(
  action: TAction,
  body: unknown,
  ingress: BackstageBookerMutationIngress
): BackstageBookerActionInputMap[TAction] {
  if (ingress === 'direct') {
    if (action === 'bookEvent') {
      const bodyRecord = asRecord(body);
      if (!bodyRecord) {
        return normalizeBackstageBookerActionPayload(action, body);
      }

      const wrappedEvent = bodyRecord.event;
      const isCanonicalWrapper = Object.prototype.hasOwnProperty.call(bodyRecord, 'universeId')
        && asRecord(wrappedEvent) !== null
        && Object.keys(bodyRecord).every(key => key === 'universeId' || key === 'event');
      if (isCanonicalWrapper) {
        return normalizeBackstageBookerActionPayload(action, bodyRecord);
      }

      const event = { ...bodyRecord };
      delete event.universeId;
      return normalizeBackstageBookerActionPayload(action, {
        universeId: Object.prototype.hasOwnProperty.call(bodyRecord, 'universeId')
          ? bodyRecord.universeId
          : DEFAULT_BACKSTAGE_UNIVERSE_ID,
        event,
      });
    }
    return normalizeBackstageBookerActionPayload(action, body);
  }

  const bodyRecord = asRecord(body);
  if (!bodyRecord) {
    return ingress === 'canonical-gpt' || ingress === 'dispatch'
      ? normalizeBackstageBookerSchemaDrivenActionPayload(action, body)
      : normalizeBackstageBookerActionPayload(action, body);
  }

  if (!Object.prototype.hasOwnProperty.call(bodyRecord, 'payload')) {
    if (ingress === 'legacy') {
      return normalizeBackstageBookerActionPayload(action, {});
    }
    const flattenedPayload = { ...bodyRecord };
    delete flattenedPayload.gptId;
    if (ingress === 'dispatch') {
      delete flattenedPayload.target;
    }
    markBackstageBookerFlattenedPayload(flattenedPayload);
    return normalizeBackstageBookerSchemaDrivenActionPayload(action, flattenedPayload);
  }

  const explicitPayload = bodyRecord.payload;
  const explicitRecord = asRecord(explicitPayload);
  const forwardsTopLevelUniverse = ingress === 'canonical-gpt' || ingress === 'dispatch';
  if (!explicitRecord) {
    if (
      action === 'updateRoster'
      && Array.isArray(explicitPayload)
      && forwardsTopLevelUniverse
      && Object.prototype.hasOwnProperty.call(bodyRecord, 'universeId')
    ) {
      return normalizeBackstageBookerActionPayload(action, {
        universeId: bodyRecord.universeId,
        wrestlers: explicitPayload
      });
    }
    return ingress === 'canonical-gpt' || ingress === 'dispatch'
      ? normalizeBackstageBookerSchemaDrivenActionPayload(action, explicitPayload)
      : normalizeBackstageBookerActionPayload(action, explicitPayload);
  }

  const dispatchPayload: Record<string, unknown> = { ...explicitRecord };
  if (
    forwardsTopLevelUniverse
    && !Object.prototype.hasOwnProperty.call(dispatchPayload, 'universeId')
    && bodyRecord.universeId !== undefined
  ) {
    dispatchPayload.universeId = bodyRecord.universeId;
  }
  markBackstageBookerExplicitPayload(dispatchPayload, Object.keys(explicitRecord));
  return ingress === 'canonical-gpt' || ingress === 'dispatch'
    ? normalizeBackstageBookerSchemaDrivenActionPayload(action, dispatchPayload)
    : normalizeBackstageBookerActionPayload(action, dispatchPayload);
}
