import type { CreateJobInput } from "./types";

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
const MAX_TOKENS = 32768;

type ValidationResult =
  | { ok: true; data: CreateJobInput }
  | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateMessage(
  value: unknown,
  index: number
): { ok: true; data: Record<string, unknown> } | { ok: false; error: string } {
  if (!isRecord(value)) {
    return { ok: false, error: `messages[${index}] must be an object` };
  }

  const role = value.role;
  if (typeof role !== "string" || !ALLOWED_ROLES.has(role)) {
    return {
      ok: false,
      error: `messages[${index}].role must be one of: ${Array.from(ALLOWED_ROLES).join(", ")}`
    };
  }

  const content = value.content;
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

  return { ok: true, data: value };
}

export function validateCreateJobInput(payload: unknown): ValidationResult {
  if (!isRecord(payload)) {
    return { ok: false, error: "Request body must be an object" };
  }

  const model = payload.model;
  if (typeof model !== "string" || model.trim().length === 0) {
    return { ok: false, error: "model must be a non-empty string" };
  }

  if (model.length > MAX_MODEL_LENGTH) {
    return {
      ok: false,
      error: `model exceeds ${MAX_MODEL_LENGTH} characters`
    };
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
  for (let index = 0; index < messages.length; index += 1) {
    const messageResult = validateMessage(messages[index], index);
    if (!messageResult.ok) {
      return messageResult;
    }
    validatedMessages.push(messageResult.data);
  }

  const result: CreateJobInput = {
    model: model.trim(),
    messages: validatedMessages
  };

  if (payload.maxTokens !== undefined) {
    if (
      typeof payload.maxTokens !== "number" ||
      !Number.isInteger(payload.maxTokens)
    ) {
      return { ok: false, error: "maxTokens must be an integer when provided" };
    }

    if (payload.maxTokens <= 0 || payload.maxTokens > MAX_TOKENS) {
      return {
        ok: false,
        error: `maxTokens must be between 1 and ${MAX_TOKENS}`
      };
    }

    result.maxTokens = payload.maxTokens;
  }

  return { ok: true, data: result };
}
