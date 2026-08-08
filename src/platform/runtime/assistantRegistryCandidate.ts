import { z } from 'zod';

const ASSISTANT_LIST_MAX_RECORDS = 1_000;
const ASSISTANT_ID_MAX_LENGTH = 256;
const ASSISTANT_NAME_MAX_LENGTH = 256;
const ASSISTANT_MODEL_MAX_LENGTH = 256;
const ASSISTANT_INSTRUCTIONS_MAX_LENGTH = 131_072;
const ASSISTANT_TOOLS_MAX_BYTES = 65_536;
const ASSISTANT_RECORD_MAX_BYTES = 196_608;
const ASSISTANT_TOOLS_MAX_DEPTH = 32;
const ASSISTANT_TOOLS_MAX_NODES = 4_096;
const ASSISTANT_RECORD_FIELDS = new Set([
  'id',
  'instructions',
  'model',
  'name',
  'normalizedName',
  'tools'
]);

export interface ValidatedAssistantRegistryRecord {
  id: string;
  name: string;
  instructions: string | null;
  tools: unknown[] | null;
  model: string | null;
  normalizedName: string;
}

export class AssistantRegistryCandidateValidationError extends Error {
  constructor() {
    super('Assistant registry candidate is invalid.');
    this.name = 'AssistantRegistryCandidateValidationError';
  }
}

function rejectCandidate(): never {
  throw new AssistantRegistryCandidateValidationError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function readBoundedString(
  value: unknown,
  maximumLength: number,
  allowLineFormatting = false
): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || (
      allowLineFormatting
        ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
        : /[\u0000-\u001F\u007F]/u.test(value)
    )
  ) {
    rejectCandidate();
  }
  return value;
}

function isJsonSafeAssistantTools(value: unknown): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [{
    depth: 0,
    value
  }];
  const visited = new WeakSet<object>();
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    nodeCount += 1;
    if (
      nodeCount > ASSISTANT_TOOLS_MAX_NODES
      || current.depth > ASSISTANT_TOOLS_MAX_DEPTH
    ) {
      return false;
    }
    if (
      current.value === null
      || typeof current.value === 'string'
      || typeof current.value === 'boolean'
    ) {
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value !== 'object' || visited.has(current.value)) {
      return false;
    }
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (Object.getPrototypeOf(current.value) !== Array.prototype) {
        return false;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(
        current.value,
        'length'
      );
      if (
        !lengthDescriptor
        || !('value' in lengthDescriptor)
        || typeof lengthDescriptor.value !== 'number'
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > ASSISTANT_TOOLS_MAX_NODES
        || Reflect.ownKeys(current.value).length !== lengthDescriptor.value + 1
      ) {
        return false;
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current.value,
          String(index)
        );
        if (!descriptor || !('value' in descriptor)) {
          return false;
        }
        pending.push({
          depth: current.depth + 1,
          value: descriptor.value
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const keys = Object.keys(current.value);
    if (Reflect.ownKeys(current.value).length !== keys.length) {
      return false;
    }
    for (const key of keys) {
      if (
        key.length === 0
        || key.length > 256
        || /[\u0000-\u001F\u007F]/u.test(key)
      ) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !('value' in descriptor)) {
        return false;
      }
      pending.push({
        depth: current.depth + 1,
        value: descriptor.value
      });
    }
  }

  return true;
}

export function normalizeAssistantName(
  name: string | null | undefined
): string | null {
  if (!name) {
    return null;
  }
  const sanitized = name
    .normalize('NFKD')
    .replace(/[^a-zA-Z0-9_\s]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  if (!sanitized) {
    return null;
  }
  const normalized = sanitized.replace(/\s+/gu, '_').toUpperCase();
  return normalized.length <= ASSISTANT_NAME_MAX_LENGTH ? normalized : null;
}

export function validateAssistantRegistryCandidate(
  value: unknown
): Array<[string, ValidatedAssistantRegistryRecord]> {
  if (!isRecord(value)) {
    rejectCandidate();
  }
  const rawEntries = Object.entries(value);
  if (rawEntries.length > ASSISTANT_LIST_MAX_RECORDS) {
    rejectCandidate();
  }

  const assistantIds = new Set<string>();
  const validatedEntries: Array<[string, ValidatedAssistantRegistryRecord]> = [];
  for (const [key, rawRecord] of rawEntries) {
    if (
      key.length === 0
      || key.length > ASSISTANT_NAME_MAX_LENGTH
      || /[\u0000-\u001F\u007F]/u.test(key)
      || !isRecord(rawRecord)
      || Object.keys(rawRecord).some(field => !ASSISTANT_RECORD_FIELDS.has(field))
    ) {
      rejectCandidate();
    }

    const id = readBoundedString(rawRecord.id, ASSISTANT_ID_MAX_LENGTH);
    const name = readBoundedString(rawRecord.name, ASSISTANT_NAME_MAX_LENGTH);
    const instructions = rawRecord.instructions === null
      ? null
      : readBoundedString(
        rawRecord.instructions,
        ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
        true
      );
    const model = rawRecord.model === undefined || rawRecord.model === null
      ? null
      : readBoundedString(rawRecord.model, ASSISTANT_MODEL_MAX_LENGTH);
    if (
      typeof rawRecord.normalizedName !== 'string'
      || rawRecord.normalizedName !== key
      || normalizeAssistantName(name) !== key
      || assistantIds.has(id)
      || (rawRecord.tools !== null && !Array.isArray(rawRecord.tools))
      || !isJsonSafeAssistantTools(rawRecord.tools)
    ) {
      rejectCandidate();
    }

    let toolsJson: string;
    try {
      toolsJson = JSON.stringify(rawRecord.tools);
    } catch {
      rejectCandidate();
    }
    if (Buffer.byteLength(toolsJson, 'utf8') > ASSISTANT_TOOLS_MAX_BYTES) {
      rejectCandidate();
    }
    const record: ValidatedAssistantRegistryRecord = {
      id,
      name,
      instructions,
      tools: JSON.parse(toolsJson) as unknown[] | null,
      model,
      normalizedName: key
    };
    if (
      Buffer.byteLength(JSON.stringify(record), 'utf8')
      > ASSISTANT_RECORD_MAX_BYTES
    ) {
      rejectCandidate();
    }
    assistantIds.add(id);
    validatedEntries.push([key, record]);
  }

  validatedEntries.sort(([left], [right]) => compareStrings(left, right));
  return validatedEntries;
}

export const assistantRegistryCandidateSchema = z.unknown().superRefine(
  (value, context) => {
    try {
      validateAssistantRegistryCandidate(value);
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Assistant registry candidate is invalid'
      });
    }
  }
);
