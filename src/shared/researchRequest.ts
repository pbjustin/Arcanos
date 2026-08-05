import { createHash } from 'node:crypto';

export const RESEARCH_MODULE_NAME = 'ARCANOS:RESEARCH';
export const RESEARCH_ACTION_NAME = 'run';
export const RESEARCH_REQUEST_VALIDATION_ERROR_CODE = 'RESEARCH_REQUEST_INVALID';

export const RESEARCH_TOPIC_MAX_LENGTH = 500;
export const RESEARCH_URL_MAX_ITEMS = 10;
export const RESEARCH_URL_MAX_LENGTH = 2_048;
export const RESEARCH_URLS_MAX_AGGREGATE_LENGTH = 16_384;
export const RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES = 97;

const RESEARCH_STORAGE_TOPIC_SLUG_MAX_LENGTH = 32;
const RESEARCH_STORAGE_HASH_SCOPE = 'research-topic-v1:utf16le\0';
const RESEARCH_REQUEST_INSPECTION_ERROR_MESSAGE =
  'Research request fields could not be safely inspected.';
const RESEARCH_PRE_ADMISSION_STRING_SCAN_MAX_LENGTH =
  (RESEARCH_TOPIC_MAX_LENGTH * 2) + 2;
const RESEARCH_PROMPT_OVER_LIMIT_SENTINEL = 'x'.repeat(
  RESEARCH_TOPIC_MAX_LENGTH + 1,
);
const RESEARCH_TOPIC_FIELDS = [
  'topic',
  'prompt',
  'message',
  'userInput',
  'content',
  'text',
  'query',
] as const;
const RESEARCH_DISPATCH_PROMPT_FIELDS = [
  'message',
  'prompt',
  'userInput',
  'content',
  'text',
  'query',
] as const;
const RESEARCH_TOP_LEVEL_DIAGNOSTIC_FIELDS = [
  'prompt',
  'message',
  'userInput',
  'content',
  'text',
  'query',
] as const;
const RESEARCH_DISPATCH_PROMPT_ALIAS_KEYS = [
  ...RESEARCH_DISPATCH_PROMPT_FIELDS,
  'messages',
] as const;
const RESEARCH_PREFLIGHT_PAYLOAD_KEYS = [
  ...RESEARCH_TOPIC_FIELDS,
  'messages',
  'urls',
  'metadata',
] as const;
const RESEARCH_CANONICAL_PAYLOAD_KEYS = ['topic', 'urls', 'metadata'] as const;

export class ResearchRequestValidationError extends TypeError {
  readonly code = RESEARCH_REQUEST_VALIDATION_ERROR_CODE;
  readonly issue: 'invalid' | 'topic_required';

  constructor(message: string, issue: 'invalid' | 'topic_required' = 'invalid') {
    super(message);
    this.name = 'ResearchRequestValidationError';
    this.issue = issue;
  }
}

export function isResearchRequestValidationError(
  value: unknown,
): value is ResearchRequestValidationError {
  return value instanceof ResearchRequestValidationError;
}

export interface ResearchRequestInput {
  topic: unknown;
  urls?: unknown;
  metadata?: unknown;
}

export interface NormalizedResearchRequest {
  topic: string;
  urls: string[];
  metadata?: Record<string, unknown>;
}

export interface ResearchGptPromptPreflight {
  promptText: string | null;
  validationError: ResearchRequestValidationError | null;
  providerIntended?: boolean;
  validationComplete?: boolean;
}

export interface ResearchDispatchPromptInspection {
  candidatePresent: boolean;
  overLimit: boolean;
  promptText: string | null;
}

interface ResearchPromptInspectionOptions {
  preserveOversizedBlank?: boolean;
}

const researchGptPromptPreflightByRequest = new WeakMap<
  object,
  ResearchGptPromptPreflight
>();

export function setResearchGptPromptPreflight(
  request: object,
  preflight: ResearchGptPromptPreflight,
): void {
  researchGptPromptPreflightByRequest.set(request, preflight);
}

export function getResearchGptPromptPreflight(
  request: object,
): ResearchGptPromptPreflight | null {
  return researchGptPromptPreflightByRequest.get(request) ?? null;
}

interface ResearchUrlAssertionOptions {
  requireArray?: boolean;
}

function inspectResearchRequestValue<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error: unknown) {
    if (isResearchRequestValidationError(error)) {
      throw error;
    }
    throw new ResearchRequestValidationError(
      RESEARCH_REQUEST_INSPECTION_ERROR_MESSAGE,
    );
  }
}

function isResearchArray(value: unknown): value is unknown[] {
  return inspectResearchRequestValue(() => Array.isArray(value));
}

function researchOwnPropertyDescriptor(
  value: object,
  key: PropertyKey,
): PropertyDescriptor | undefined {
  return inspectResearchRequestValue(
    () => Object.getOwnPropertyDescriptor(value, key),
  );
}

function researchOwnPropertyDescriptors(value: object): PropertyDescriptorMap {
  return inspectResearchRequestValue(
    () => Object.getOwnPropertyDescriptors(value),
  );
}

function researchArrayLength(value: unknown[]): number {
  const descriptor = researchOwnPropertyDescriptor(value, 'length');
  const length = descriptor && 'value' in descriptor
    ? descriptor.value
    : undefined;
  if (
    typeof length !== 'number'
    || !Number.isSafeInteger(length)
    || length < 0
  ) {
    throw new ResearchRequestValidationError(
      RESEARCH_REQUEST_INSPECTION_ERROR_MESSAGE,
    );
  }
  return length;
}

function ownDataProperty(value: object, key: PropertyKey): unknown {
  const descriptor = researchOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function hasOwnDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = researchOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && 'value' in descriptor);
}

function copyOwnDataProperties(
  value: object,
  keys: readonly PropertyKey[],
): Record<string, unknown> {
  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys) {
    const descriptor = researchOwnPropertyDescriptor(value, key);
    if (descriptor && 'value' in descriptor && typeof key === 'string') {
      entries.push([key, descriptor.value]);
    }
  }
  return Object.fromEntries(entries);
}

function copyExplicitResearchPayloadDataProperties(
  value: object,
  keys: readonly PropertyKey[] | null,
  accessorErrorMessage = 'Research explicit payload fields must be plain data properties.',
): Record<string, unknown> {
  const descriptors = researchOwnPropertyDescriptors(value);
  const descriptorKeys = Reflect.ownKeys(descriptors);
  for (const key of descriptorKeys) {
    const descriptor = descriptors[key as keyof typeof descriptors];
    if (descriptor?.enumerable && !('value' in descriptor)) {
      throw new ResearchRequestValidationError(
        accessorErrorMessage,
      );
    }
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const key of keys ?? descriptorKeys) {
    if (typeof key !== 'string') {
      continue;
    }
    const descriptor = descriptors[key];
    if (descriptor?.enumerable && 'value' in descriptor) {
      entries.push([key, descriptor.value]);
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Produces the descriptor-only body consumed by Research GPT preflight before
 * generic GPT normalization can enumerate request properties.
 */
export function snapshotResearchGptPreflightBody(body: unknown): unknown {
  if (!body || typeof body !== 'object' || isResearchArray(body)) {
    return body;
  }

  const snapshot = copyExplicitResearchPayloadDataProperties(
    body,
    null,
    'Research request fields must be plain data properties.',
  );
  const explicitPayload = snapshot.payload;
  if (
    explicitPayload
    && typeof explicitPayload === 'object'
    && !isResearchArray(explicitPayload)
  ) {
    snapshot.payload = copyExplicitResearchPayloadDataProperties(
      explicitPayload,
      null,
    );
  }
  return snapshot;
}

function hasNonWhitespace(value: string): boolean {
  return /\S/u.test(value);
}

interface RawResearchPromptOptions {
  preserveOversizedBlank: boolean;
}

function extractRawLastUserMessageText(
  messages: unknown,
  options: RawResearchPromptOptions,
): string | undefined {
  if (!isResearchArray(messages)) {
    return undefined;
  }

  for (let index = researchArrayLength(messages) - 1; index >= 0; index -= 1) {
    const message = ownDataProperty(messages, String(index));
    if (!message || typeof message !== 'object' || isResearchArray(message)) {
      continue;
    }
    if (ownDataProperty(message, 'role') !== 'user') {
      continue;
    }

    const content = ownDataProperty(message, 'content');
    if (typeof content === 'string') {
      if (hasNonWhitespace(content)) {
        return content.length > RESEARCH_TOPIC_MAX_LENGTH
          ? content.slice(0, RESEARCH_TOPIC_MAX_LENGTH + 1)
          : content;
      }
      if (options.preserveOversizedBlank && content.length > RESEARCH_TOPIC_MAX_LENGTH) {
        return RESEARCH_PROMPT_OVER_LIMIT_SENTINEL;
      }
      continue;
    }
    if (!isResearchArray(content)) {
      continue;
    }

    let rawLength = 0;
    let rawLengthOverLimit = false;
    const normalizedParts: string[] = [];
    const contentLength = researchArrayLength(content);
    for (let partIndex = 0; partIndex < contentLength; partIndex += 1) {
      const part = ownDataProperty(content, String(partIndex));
      let text: string | undefined;
      if (typeof part === 'string') {
        text = part;
      } else if (part && typeof part === 'object' && !isResearchArray(part)) {
        const textValue = ownDataProperty(part, 'text');
        if (typeof textValue === 'string') {
          text = textValue;
        }
      }

      if (text === undefined) {
        continue;
      }

      rawLength += text.length;
      if (rawLength > RESEARCH_TOPIC_MAX_LENGTH) {
        if (options.preserveOversizedBlank) {
          return RESEARCH_PROMPT_OVER_LIMIT_SENTINEL;
        }
        rawLengthOverLimit = true;
      }

      const normalizedText = text.trim();
      if (normalizedText && normalizedParts.length > 0) {
        rawLength += 1;
        if (rawLength > RESEARCH_TOPIC_MAX_LENGTH) {
          if (options.preserveOversizedBlank) {
            return RESEARCH_PROMPT_OVER_LIMIT_SENTINEL;
          }
          rawLengthOverLimit = true;
        }
      }

      if (normalizedText) {
        normalizedParts.push(normalizedText);
      }
    }
    if (normalizedParts.length > 0) {
      return rawLengthOverLimit
        ? RESEARCH_PROMPT_OVER_LIMIT_SENTINEL
        : normalizedParts.join('\n');
    }
  }

  return undefined;
}

function extractRawDispatchPromptText(
  record: object,
  options: RawResearchPromptOptions,
): string | undefined {
  let directCandidate: unknown;
  for (const field of RESEARCH_DISPATCH_PROMPT_FIELDS) {
    const candidate = ownDataProperty(record, field);
    if (candidate) {
      directCandidate = candidate;
      break;
    }
  }

  if (typeof directCandidate === 'string') {
    if (hasNonWhitespace(directCandidate)) {
      return directCandidate.length > RESEARCH_TOPIC_MAX_LENGTH
        ? directCandidate.slice(0, RESEARCH_TOPIC_MAX_LENGTH + 1)
        : directCandidate;
    }
    if (
      options.preserveOversizedBlank
      && directCandidate.length > RESEARCH_TOPIC_MAX_LENGTH
    ) {
      return RESEARCH_PROMPT_OVER_LIMIT_SENTINEL;
    }
  }

  return extractRawLastUserMessageText(
    ownDataProperty(record, 'messages'),
    options,
  );
}

function extractRawTopLevelDiagnosticText(record: object): string | undefined {
  for (const field of RESEARCH_TOP_LEVEL_DIAGNOSTIC_FIELDS) {
    const candidate = ownDataProperty(record, field);
    if (typeof candidate !== 'string') {
      continue;
    }
    if (hasNonWhitespace(candidate)) {
      return candidate.length > RESEARCH_TOPIC_MAX_LENGTH
        ? candidate.slice(0, RESEARCH_TOPIC_MAX_LENGTH + 1)
        : candidate;
    }
  }

  return undefined;
}

function inspectRawResearchPromptCandidate(
  candidate: string | undefined,
): ResearchDispatchPromptInspection {
  if (candidate === undefined) {
    return {
      candidatePresent: false,
      overLimit: false,
      promptText: null,
    };
  }

  const overLimit = candidate.length > RESEARCH_TOPIC_MAX_LENGTH;
  return {
    candidatePresent: true,
    overLimit,
    promptText: overLimit ? null : candidate.trim() || null,
  };
}

function inspectBoundedDirectPromptCandidate(
  record: object,
  fields: readonly string[],
  skipTruthyNonString: boolean,
): ResearchDispatchPromptInspection {
  for (const field of fields) {
    const candidate = ownDataProperty(record, field);
    if (!candidate) {
      continue;
    }
    if (typeof candidate !== 'string') {
      if (skipTruthyNonString) {
        continue;
      }
      return inspectRawResearchPromptCandidate(undefined);
    }
    if (candidate.length > RESEARCH_TOPIC_MAX_LENGTH) {
      if (candidate.length <= RESEARCH_PRE_ADMISSION_STRING_SCAN_MAX_LENGTH) {
        const normalizedCandidate = candidate.trim();
        if (normalizedCandidate.length <= RESEARCH_TOPIC_MAX_LENGTH) {
          return normalizedCandidate
            ? inspectRawResearchPromptCandidate(normalizedCandidate)
            : {
                candidatePresent: false,
                overLimit: true,
                promptText: null,
              };
        }
      }
      return {
        candidatePresent: true,
        overLimit: true,
        promptText: null,
      };
    }
    if (hasNonWhitespace(candidate)) {
      return inspectRawResearchPromptCandidate(candidate);
    }

    // Dispatcher `a || b` precedence stops at a truthy whitespace string.
    return inspectRawResearchPromptCandidate(undefined);
  }

  return inspectRawResearchPromptCandidate(undefined);
}

/** Fixed-cost prompt probe used only before public provider admission. */
export function inspectResearchPreAdmissionPromptText(
  body: unknown,
): ResearchDispatchPromptInspection {
  if (!body || typeof body !== 'object' || isResearchArray(body)) {
    return inspectRawResearchPromptCandidate(undefined);
  }

  if (!hasOwnDataProperty(body, 'payload')) {
    return inspectBoundedDirectPromptCandidate(
      body,
      RESEARCH_DISPATCH_PROMPT_FIELDS,
      false,
    );
  }

  const explicitPayload = ownDataProperty(body, 'payload');
  if (explicitPayload && typeof explicitPayload === 'object' && !isResearchArray(explicitPayload)) {
    const explicitInspection = inspectBoundedDirectPromptCandidate(
      explicitPayload,
      RESEARCH_DISPATCH_PROMPT_FIELDS,
      false,
    );
    if (explicitInspection.candidatePresent) {
      return explicitInspection;
    }
    if (hasOwnDataProperty(explicitPayload, 'messages')) {
      return explicitInspection;
    }
  }

  return inspectBoundedDirectPromptCandidate(
    body,
    RESEARCH_TOP_LEVEL_DIAGNOSTIC_FIELDS,
    true,
  );
}

/**
 * Selects the raw effective research payload before the general GPT dispatcher
 * can trim prompt aliases. Explicit payload precedence and top-level forwarding
 * match the dispatcher contract for the fields consumed by ARCANOS:RESEARCH.
 */
export function buildResearchModulePreflightPayload(
  body: unknown,
  promptFallback?: string,
): unknown {
  if (!body || typeof body !== 'object' || isResearchArray(body)) {
    return body;
  }

  if (hasOwnDataProperty(body, 'payload')) {
    const explicitPayload = ownDataProperty(body, 'payload');
    if (!explicitPayload || typeof explicitPayload !== 'object' || isResearchArray(explicitPayload)) {
      return explicitPayload;
    }

    const researchPayload = copyExplicitResearchPayloadDataProperties(
      explicitPayload,
      RESEARCH_PREFLIGHT_PAYLOAD_KEYS,
    );
    const hasExplicitPromptAlias = RESEARCH_DISPATCH_PROMPT_ALIAS_KEYS
      .some((field) => researchOwnPropertyDescriptor(explicitPayload, field) !== undefined);
    if (!hasExplicitPromptAlias) {
      for (const field of RESEARCH_DISPATCH_PROMPT_FIELDS) {
        const forwardedValue = ownDataProperty(body, field);
        if (forwardedValue !== undefined) {
          researchPayload[field] = forwardedValue;
        }
      }
      const forwardedMessages = ownDataProperty(body, 'messages');
      if (forwardedMessages !== undefined) {
        researchPayload.messages = forwardedMessages;
      }
      if (promptFallback !== undefined) {
        researchPayload.prompt = promptFallback;
      }
    }

    if (!hasOwnDataProperty(researchPayload, 'urls')) {
      const forwardedUrls = ownDataProperty(body, 'urls');
      if (forwardedUrls !== undefined) {
        researchPayload.urls = forwardedUrls;
      }
    }
    return researchPayload;
  }

  const researchPayload = copyOwnDataProperties(body, RESEARCH_CANONICAL_PAYLOAD_KEYS);
  const rawTopic = ownDataProperty(body, 'topic');
  if (typeof rawTopic === 'string') {
    if (rawTopic.length > RESEARCH_TOPIC_MAX_LENGTH || hasNonWhitespace(rawTopic)) {
      return researchPayload;
    }
  }

  const promptText = extractRawDispatchPromptText(body, {
    preserveOversizedBlank: true,
  });
  if (promptText !== undefined) {
    researchPayload.prompt = promptText;
  } else if (promptFallback !== undefined) {
    researchPayload.prompt = promptFallback;
  }
  return researchPayload;
}

function buildResearchPromptInspectionPayload(body: unknown): unknown {
  if (!body || typeof body !== 'object' || isResearchArray(body)) {
    return body;
  }
  if (!hasOwnDataProperty(body, 'payload')) {
    return body;
  }

  const explicitPayload = ownDataProperty(body, 'payload');
  if (!explicitPayload || typeof explicitPayload !== 'object' || isResearchArray(explicitPayload)) {
    return explicitPayload;
  }

  const mergedPayload = copyOwnDataProperties(
    explicitPayload,
    RESEARCH_PREFLIGHT_PAYLOAD_KEYS,
  );
  const hasExplicitPromptAlias = RESEARCH_DISPATCH_PROMPT_ALIAS_KEYS
    .some((field) => hasOwnDataProperty(explicitPayload, field));
  if (!hasExplicitPromptAlias) {
    for (const field of RESEARCH_DISPATCH_PROMPT_FIELDS) {
      const forwardedValue = ownDataProperty(body, field);
      if (forwardedValue !== undefined) {
        mergedPayload[field] = forwardedValue;
      }
    }
    const forwardedMessages = ownDataProperty(body, 'messages');
    if (forwardedMessages !== undefined) {
      mergedPayload.messages = forwardedMessages;
    }
  }

  return mergedPayload;
}

/**
 * Extracts dispatcher-compatible text for canonical research route planning
 * without joining more than the approved topic limit plus one sentinel unit.
 */
export function inspectBoundedResearchDispatchPromptText(
  body: unknown,
  options: ResearchPromptInspectionOptions = {},
): ResearchDispatchPromptInspection {
  const payload = buildResearchPromptInspectionPayload(body);
  if (!payload || typeof payload !== 'object' || isResearchArray(payload)) {
    return inspectRawResearchPromptCandidate(undefined);
  }

  const payloadInspection = inspectRawResearchPromptCandidate(
    extractRawDispatchPromptText(payload, {
      preserveOversizedBlank: options.preserveOversizedBlank === true,
    }),
  );
  if (payloadInspection.candidatePresent) {
    return payloadInspection;
  }

  if (
    body
    && typeof body === 'object'
    && !isResearchArray(body)
    && hasOwnDataProperty(body, 'payload')
  ) {
    return inspectRawResearchPromptCandidate(
      extractRawTopLevelDiagnosticText(body),
    );
  }

  return payloadInspection;
}

export function extractBoundedResearchDispatchPromptText(body: unknown): string | null {
  return inspectBoundedResearchDispatchPromptText(body).promptText;
}

/**
 * Enforces fixed URL amplification limits before trimming, filtering, or URL parsing.
 * Array slots count toward the cardinality limit even when blank, invalid, duplicated, or sparse.
 */
export function assertResearchUrlsPreNormalization(
  value: unknown,
  options: ResearchUrlAssertionOptions = {},
): void {
  snapshotResearchUrlsPreNormalization(value, options);
}

function snapshotResearchUrlsPreNormalization(
  value: unknown,
  options: ResearchUrlAssertionOptions = {},
): unknown[] | null {
  if (value === undefined || value === null) {
    if (options.requireArray) {
      throw new ResearchRequestValidationError('Research URLs must be an array.');
    }
    return null;
  }

  if (!isResearchArray(value)) {
    if (options.requireArray) {
      throw new ResearchRequestValidationError('Research URLs must be an array.');
    }
    return null;
  }

  const suppliedLength = researchArrayLength(value);
  if (suppliedLength > RESEARCH_URL_MAX_ITEMS) {
    throw new ResearchRequestValidationError(
      `Research URLs must contain no more than ${RESEARCH_URL_MAX_ITEMS} entries.`,
    );
  }

  let aggregateLength = 0;
  const entries: unknown[] = [];

  for (let index = 0; index < suppliedLength; index += 1) {
    const candidate = ownDataProperty(value, String(index));
    entries.push(candidate);
    if (typeof candidate !== 'string') {
      continue;
    }

    if (candidate.length > RESEARCH_URL_MAX_LENGTH) {
      throw new ResearchRequestValidationError(
        `Each research URL must be no more than ${RESEARCH_URL_MAX_LENGTH} JavaScript String.length units.`,
      );
    }

    aggregateLength += candidate.length;
    if (aggregateLength > RESEARCH_URLS_MAX_AGGREGATE_LENGTH) {
      throw new ResearchRequestValidationError(
        `Research URLs must total no more than ${RESEARCH_URLS_MAX_AGGREGATE_LENGTH} JavaScript String.length units.`,
      );
    }
  }

  return entries;
}

export function normalizeResearchRequest(
  input: ResearchRequestInput,
): NormalizedResearchRequest {
  const rawTopic = ownDataProperty(input, 'topic');
  const rawUrls = ownDataProperty(input, 'urls');
  const rawMetadata = ownDataProperty(input, 'metadata');

  if (typeof rawTopic !== 'string') {
    throw new ResearchRequestValidationError(
      'Research topic must be a string.',
      rawTopic === undefined ? 'topic_required' : 'invalid',
    );
  }

  if (rawTopic.length > RESEARCH_TOPIC_MAX_LENGTH) {
    throw new ResearchRequestValidationError(
      `Research topic must be no more than ${RESEARCH_TOPIC_MAX_LENGTH} JavaScript String.length units.`,
    );
  }

  const topic = rawTopic.trim();
  if (!topic) {
    throw new ResearchRequestValidationError('Research topic is required.');
  }

  const rawUrlEntries = snapshotResearchUrlsPreNormalization(rawUrls);

  const urls: string[] = [];
  if (rawUrlEntries) {
    for (const candidate of rawUrlEntries) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const normalized = candidate.trim();
      if (normalized) {
        urls.push(normalized);
      }
    }
  }

  const metadata = rawMetadata
    && typeof rawMetadata === 'object'
    && !isResearchArray(rawMetadata)
    ? rawMetadata as Record<string, unknown>
    : undefined;

  return { topic, urls, metadata };
}

/** Applies the direct HTTP/SDK array-shape contract before normalization. */
export function normalizeResearchHttpRequest(
  input: ResearchRequestInput,
): NormalizedResearchRequest {
  const rawTopic = ownDataProperty(input, 'topic');
  const suppliedUrls = ownDataProperty(input, 'urls');
  const rawUrls = suppliedUrls === undefined ? [] : suppliedUrls;
  const rawMetadata = ownDataProperty(input, 'metadata');
  const urlEntries = snapshotResearchUrlsPreNormalization(rawUrls, { requireArray: true });

  if (!urlEntries || urlEntries.some((entry) => typeof entry !== 'string')) {
    throw new ResearchRequestValidationError(
      "Field 'urls' must be an array of strings",
    );
  }

  return normalizeResearchRequest({
    topic: rawTopic,
    urls: urlEntries,
    metadata: rawMetadata,
  });
}

/** Normalizes the scalar or object payload accepted by ARCANOS:RESEARCH aliases. */
export function normalizeResearchModulePayload(
  payload: unknown,
): NormalizedResearchRequest {
  if (typeof payload === 'string') {
    return normalizeResearchRequest({ topic: payload });
  }

  if (!payload || typeof payload !== 'object' || isResearchArray(payload)) {
    return normalizeResearchRequest({ topic: undefined });
  }

  let topic: unknown;
  for (const field of RESEARCH_TOPIC_FIELDS) {
    const candidate = ownDataProperty(payload, field);
    if (typeof candidate === 'string') {
      if (candidate.length > RESEARCH_TOPIC_MAX_LENGTH) {
        throw new ResearchRequestValidationError(
          `Research topic must be no more than ${RESEARCH_TOPIC_MAX_LENGTH} JavaScript String.length units.`,
        );
      }
      if (hasNonWhitespace(candidate)) {
        topic = candidate;
        break;
      }
    }
  }

  return normalizeResearchRequest({
    topic,
    urls: ownDataProperty(payload, 'urls'),
    metadata: ownDataProperty(payload, 'metadata'),
  });
}

/**
 * Produces a deterministic ASCII storage component with a readable prefix and
 * a full scoped SHA-256 digest. The result is at most 97 UTF-8 bytes.
 */
export function buildResearchStorageTopicComponent(topic: string): string {
  const readableSlug = topic
    .replace(/[A-Z]/g, (character) => character.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, RESEARCH_STORAGE_TOPIC_SLUG_MAX_LENGTH)
    .replace(/-+$/g, '') || 'topic';
  const digest = createHash('sha256')
    .update(RESEARCH_STORAGE_HASH_SCOPE, 'utf8')
    .update(topic, 'utf16le')
    .digest('hex');
  const component = `${readableSlug}-${digest}`;

  // The ASCII slug and digest make this an invariant, but retain a fail-closed guard.
  if (Buffer.byteLength(component, 'utf8') > RESEARCH_STORAGE_TOPIC_COMPONENT_MAX_BYTES) {
    throw new Error('Research storage topic component exceeded its fixed byte limit.');
  }

  return component;
}
