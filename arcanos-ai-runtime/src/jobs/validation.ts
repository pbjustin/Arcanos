import type { CreateJobInput } from "./types.js";
import type { RuntimeJobPolicy } from "./policy.js";

const ALLOWED_ROLES = new Set([
  "system",
  "user",
  "assistant",
  "developer",
  "tool",
  "function"
]);

const MAX_MODEL_LENGTH = 120;
const MAX_MESSAGES = 100;
const MAX_STRING_CONTENT_LENGTH = 64000;
const PROTOTYPE_RELEVANT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype"
]);

export const AI_RUNTIME_JOB_INPUT_LIMITS = Object.freeze({
  maxDepth: 16,
  maxNodes: 8192,
  maxArrayItems: 256,
  maxObjectKeys: 64,
  maxTotalObjectKeys: 4096,
  maxKeyBytes: 128,
  maxStringBytes: 64 * 1024,
  maxTotalStringBytes: 192 * 1024
});

type ValidationResult =
  | { ok: true; data: CreateJobInput }
  | { ok: false; error: string };

type JsonCloneResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

interface JsonComplexityBudget {
  nodes: number;
  objectKeys: number;
  stringBytes: number;
  seenObjects: WeakSet<object>;
}

interface PendingJsonValue {
  value: unknown;
  depth: number;
  path: string;
  assign: (value: unknown) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createJsonComplexityBudget(): JsonComplexityBudget {
  return {
    nodes: 0,
    objectKeys: 0,
    stringBytes: 0,
    seenObjects: new WeakSet<object>()
  };
}

function isPlainJsonObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function addStringToBudget(
  value: string,
  path: string,
  budget: JsonComplexityBudget
): string | null {
  const stringBytes = Buffer.byteLength(value, "utf8");
  if (stringBytes > AI_RUNTIME_JOB_INPUT_LIMITS.maxStringBytes) {
    return `${path} exceeds ${AI_RUNTIME_JOB_INPUT_LIMITS.maxStringBytes} UTF-8 bytes`;
  }

  budget.stringBytes += stringBytes;
  if (
    budget.stringBytes >
    AI_RUNTIME_JOB_INPUT_LIMITS.maxTotalStringBytes
  ) {
    return `messages exceed ${AI_RUNTIME_JOB_INPUT_LIMITS.maxTotalStringBytes} aggregate UTF-8 string bytes`;
  }

  return null;
}

function cloneBoundedJsonValue(
  rootValue: unknown,
  rootPath: string,
  budget: JsonComplexityBudget
): JsonCloneResult {
  let clonedRoot: unknown;
  const pending: PendingJsonValue[] = [
    {
      value: rootValue,
      depth: 0,
      path: rootPath,
      assign(value) {
        clonedRoot = value;
      }
    }
  ];

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      break;
    }

    budget.nodes += 1;
    if (budget.nodes > AI_RUNTIME_JOB_INPUT_LIMITS.maxNodes) {
      return {
        ok: false,
        error: `messages exceed ${AI_RUNTIME_JOB_INPUT_LIMITS.maxNodes} JSON values`
      };
    }

    const value = current.value;
    if (value === null || typeof value === "boolean") {
      current.assign(value);
      continue;
    }

    if (typeof value === "string") {
      const stringError = addStringToBudget(value, current.path, budget);
      if (stringError) {
        return { ok: false, error: stringError };
      }
      current.assign(value);
      continue;
    }

    if (typeof value === "number") {
      if (!Number.isFinite(value)) {
        return {
          ok: false,
          error: `${current.path} must contain only finite JSON numbers`
        };
      }
      current.assign(value);
      continue;
    }

    if (typeof value !== "object") {
      return {
        ok: false,
        error: `${current.path} must contain only JSON-compatible values`
      };
    }

    if (current.depth >= AI_RUNTIME_JOB_INPUT_LIMITS.maxDepth) {
      return {
        ok: false,
        error: `${current.path} exceeds the maximum JSON nesting depth of ${AI_RUNTIME_JOB_INPUT_LIMITS.maxDepth}`
      };
    }

    if (budget.seenObjects.has(value)) {
      return {
        ok: false,
        error: `${current.path} contains a repeated or cyclic object reference`
      };
    }
    budget.seenObjects.add(value);

    if (Array.isArray(value)) {
      if (value.length > AI_RUNTIME_JOB_INPUT_LIMITS.maxArrayItems) {
        return {
          ok: false,
          error: `${current.path} exceeds ${AI_RUNTIME_JOB_INPUT_LIMITS.maxArrayItems} array entries`
        };
      }

      const clonedArray = new Array<unknown>(value.length);
      current.assign(clonedArray);
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({
          value: value[index],
          depth: current.depth + 1,
          path: `${current.path}[${index}]`,
          assign(childValue) {
            clonedArray[index] = childValue;
          }
        });
      }
      continue;
    }

    if (!isPlainJsonObject(value)) {
      return {
        ok: false,
        error: `${current.path} must contain only plain JSON objects`
      };
    }

    const sourceObject = value as Record<string, unknown>;
    const keys = Object.keys(sourceObject);
    if (keys.length > AI_RUNTIME_JOB_INPUT_LIMITS.maxObjectKeys) {
      return {
        ok: false,
        error: `${current.path} exceeds ${AI_RUNTIME_JOB_INPUT_LIMITS.maxObjectKeys} object keys`
      };
    }

    budget.objectKeys += keys.length;
    if (
      budget.objectKeys >
      AI_RUNTIME_JOB_INPUT_LIMITS.maxTotalObjectKeys
    ) {
      return {
        ok: false,
        error: `messages exceed ${AI_RUNTIME_JOB_INPUT_LIMITS.maxTotalObjectKeys} aggregate object keys`
      };
    }

    const clonedObject: Record<string, unknown> = {};
    current.assign(clonedObject);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      if (key === undefined) {
        continue;
      }
      if (PROTOTYPE_RELEVANT_KEYS.has(key)) {
        return {
          ok: false,
          error: `${current.path} contains a reserved object key`
        };
      }
      if (
        Buffer.byteLength(key, "utf8") >
        AI_RUNTIME_JOB_INPUT_LIMITS.maxKeyBytes
      ) {
        return {
          ok: false,
          error: `${current.path} contains an object key exceeding ${AI_RUNTIME_JOB_INPUT_LIMITS.maxKeyBytes} UTF-8 bytes`
        };
      }

      pending.push({
        value: sourceObject[key],
        depth: current.depth + 1,
        path: `${current.path}.${key}`,
        assign(childValue) {
          clonedObject[key] = childValue;
        }
      });
    }
  }

  return { ok: true, data: clonedRoot };
}

function validateMessage(
  value: unknown,
  index: number,
  budget: JsonComplexityBudget
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: `messages[${index}] must be an object` };
  }

  const clonedMessage = cloneBoundedJsonValue(
    value,
    `messages[${index}]`,
    budget
  );
  if (!clonedMessage.ok) {
    return clonedMessage;
  }
  if (!isRecord(clonedMessage.data)) {
    return { ok: false, error: `messages[${index}] must be an object` };
  }

  const role = clonedMessage.data.role;
  if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
    return {
      ok: false,
      error: `messages[${index}].role must be one of: ${Array.from(ALLOWED_ROLES).join(", ")}`
    };
  }

  const content = clonedMessage.data.content;
  if (content === undefined) {
    return { ok: false, error: `messages[${index}].content is required` };
  }

  const validContentType =
    typeof content === "string" ||
    Array.isArray(content) ||
    (content !== null && typeof content === "object");

  if (!validContentType) {
    return {
      ok: false,
      error: `messages[${index}].content must be a string, array, or object`
    };
  }

  if (
    typeof content === "string" &&
    content.length > MAX_STRING_CONTENT_LENGTH
  ) {
    return {
      ok: false,
      error: `messages[${index}].content exceeds ${MAX_STRING_CONTENT_LENGTH} characters`
    };
  }

  return { ok: true, data: clonedMessage.data };
}

export function validateCreateJobInput(
  payload: unknown,
  policy: RuntimeJobPolicy
): ValidationResult {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be an object" };
  }

  const model = payload.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    return { ok: false, error: "model must be a non-empty string" };
  }

  const normalizedModel = model.trim();
  if (normalizedModel.length > MAX_MODEL_LENGTH) {
    return {
      ok: false,
      error: `model exceeds ${MAX_MODEL_LENGTH} characters`
    };
  }

  if (!policy.allowedModels.includes(normalizedModel)) {
    return { ok: false, error: "model is not permitted" };
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return { ok: false, error: "messages must be a non-empty array" };
  }

  if (messages.length > MAX_MESSAGES) {
    return {
      ok: false,
      error: `messages cannot exceed ${MAX_MESSAGES} entries`
    };
  }

  const validatedMessages: Array<Record<string, unknown>> = [];
  const complexityBudget = createJsonComplexityBudget();
  for (let index = 0; index < messages.length; index += 1) {
    const messageResult = validateMessage(
      messages[index],
      index,
      complexityBudget
    );
    if (!messageResult.ok) {
      return messageResult;
    }
    validatedMessages.push(messageResult.data);
  }

  const result: CreateJobInput = {
    model: normalizedModel,
    messages: validatedMessages
  };

  const effectiveMaxTokens =
    payload.maxTokens === undefined
      ? policy.defaultMaxTokens
      : payload.maxTokens;
  if (
    typeof effectiveMaxTokens !== "number" ||
    !Number.isInteger(effectiveMaxTokens)
  ) {
    return { ok: false, error: "maxTokens must be an integer when provided" };
  }

  const maximumTokens = policy.maxTokens;
  if (
    effectiveMaxTokens <= 0 ||
    effectiveMaxTokens > maximumTokens
  ) {
    return {
      ok: false,
      error: `maxTokens must be between 1 and ${maximumTokens}`
    };
  }

  result.maxTokens = effectiveMaxTokens;
  return { ok: true, data: result };
}
