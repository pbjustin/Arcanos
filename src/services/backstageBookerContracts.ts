import { createHash } from 'crypto';
import {
  DEFAULT_BACKSTAGE_UNIVERSE_ID,
  validateBackstageBookerActionPayload,
  type BackstageBookerAction,
  type BackstageBookerActionInputMap,
  type ValidationIssue
} from '@arcanos/protocol';
import { parseBackstageRosterPayload } from '@shared/backstage/backstageRoster.js';
import {
  BACKSTAGE_STORYLINE_MAX_BYTES,
  BackstageStorylineValidationError,
  parseBackstageStorylinePayload
} from '@shared/backstage/backstageStoryline.js';

export const BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS = '__arcanosBackstageExplicitPayloadFields';
export const BACKSTAGE_FLATTENED_PAYLOAD_FLAG = '__arcanosBackstageFlattenedPayload';

export type BackstageBookerMutationIngress =
  | 'canonical-gpt'
  | 'direct'
  | 'dispatch'
  | 'legacy';

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

function normalizeExplicitFieldNames(value: unknown): Set<string> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return new Set(value.filter((entry): entry is string => typeof entry === 'string'));
}

function sanitizeOpenPayloadRecord(record: Record<string, unknown>): Record<string, unknown> {
  const explicitFields = normalizeExplicitFieldNames(record[BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS]);
  const flattenedPayload = record[BACKSTAGE_FLATTENED_PAYLOAD_FLAG] === true;
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
  const explicitFields = normalizeExplicitFieldNames(
    rawRecord[BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS]
  );
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
      assertOpenPayloadJson(action, event);
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
  }
}

/**
 * Normalize legacy Booker payloads to the v1 module-action contract and validate before effects.
 */
export function normalizeBackstageBookerActionPayload<TAction extends BackstageBookerAction>(
  action: TAction,
  payload: unknown
): BackstageBookerActionInputMap[TAction] {
  const candidate = normalizeCandidate(action, payload);
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
 * Resolve the mutation payload that an HTTP ingress will pass to the Booker action adapter.
 * The returned canonical value is safe to use for both confirmation fingerprints and
 * validation-before-effects; callers may keep their original transport envelope unchanged.
 */
export function normalizeBackstageBookerIngressMutationPayload<
  TAction extends 'trackStoryline' | 'updateRoster'
>(
  action: TAction,
  body: unknown,
  ingress: BackstageBookerMutationIngress
): BackstageBookerActionInputMap[TAction] {
  if (ingress === 'direct') {
    return normalizeBackstageBookerActionPayload(action, body);
  }

  const bodyRecord = asRecord(body);
  if (!bodyRecord) {
    return normalizeBackstageBookerActionPayload(action, body);
  }

  if (!Object.prototype.hasOwnProperty.call(bodyRecord, 'payload')) {
    if (ingress === 'dispatch' || ingress === 'legacy') {
      return normalizeBackstageBookerActionPayload(action, {});
    }
    const flattenedPayload = { ...bodyRecord };
    delete flattenedPayload.gptId;
    flattenedPayload[BACKSTAGE_FLATTENED_PAYLOAD_FLAG] = true;
    return normalizeBackstageBookerActionPayload(action, flattenedPayload);
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
    return normalizeBackstageBookerActionPayload(action, explicitPayload);
  }

  const dispatchPayload: Record<string, unknown> = { ...explicitRecord };
  if (
    forwardsTopLevelUniverse
    && !Object.prototype.hasOwnProperty.call(dispatchPayload, 'universeId')
    && bodyRecord.universeId !== undefined
  ) {
    dispatchPayload.universeId = bodyRecord.universeId;
  }
  dispatchPayload[BACKSTAGE_EXPLICIT_PAYLOAD_FIELDS] = Object.keys(explicitRecord);
  return normalizeBackstageBookerActionPayload(action, dispatchPayload);
}
