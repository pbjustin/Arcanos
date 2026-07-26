export const AI_RUNTIME_ALLOWED_MODELS_ENV_NAME =
  "AI_RUNTIME_ALLOWED_MODELS";
export const AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME =
  "AI_RUNTIME_DEFAULT_MAX_TOKENS";
export const AI_RUNTIME_MAX_TOKENS_ENV_NAME =
  "AI_RUNTIME_MAX_TOKENS";

const MAX_CONFIGURED_MODELS = 32;
const MAX_MODEL_LENGTH = 120;
const MAX_CONFIGURED_MODELS_LENGTH =
  MAX_CONFIGURED_MODELS * (MAX_MODEL_LENGTH + 1);
const MAX_PROVIDER_OUTPUT_TOKENS = 32768;
const MODEL_NAME_PATTERN = /^[\x21-\x7e]+$/u;
const INTEGER_PATTERN = /^[1-9][0-9]*$/u;

export interface RuntimeJobPolicy {
  allowedModels: readonly string[];
  defaultMaxTokens: number;
  maxTokens: number;
}

function parseRequiredInteger(
  raw: string | undefined,
  maximum: number
): number | null {
  if (
    typeof raw !== "string" ||
    raw !== raw.trim() ||
    !INTEGER_PATTERN.test(raw)
  ) {
    return null;
  }

  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= maximum
    ? value
    : null;
}

function parseAllowedModels(
  raw: string | undefined
): readonly string[] | null {
  if (
    typeof raw !== "string" ||
    raw.length === 0 ||
    raw.length > MAX_CONFIGURED_MODELS_LENGTH
  ) {
    return null;
  }

  const modelNames = raw.split(",");
  if (
    modelNames.length === 0 ||
    modelNames.length > MAX_CONFIGURED_MODELS
  ) {
    return null;
  }

  const allowedModels = new Set<string>();
  for (const rawModelName of modelNames) {
    const modelName = rawModelName.trim();
    if (
      modelName.length === 0 ||
      modelName.length > MAX_MODEL_LENGTH ||
      !MODEL_NAME_PATTERN.test(modelName) ||
      allowedModels.has(modelName)
    ) {
      return null;
    }
    allowedModels.add(modelName);
  }

  return Object.freeze([...allowedModels]);
}

export function resolveRuntimeJobPolicy(
  environment: NodeJS.ProcessEnv
): RuntimeJobPolicy | null {
  const allowedModels = parseAllowedModels(
    environment[AI_RUNTIME_ALLOWED_MODELS_ENV_NAME]
  );
  const defaultMaxTokens = parseRequiredInteger(
    environment[AI_RUNTIME_DEFAULT_MAX_TOKENS_ENV_NAME],
    MAX_PROVIDER_OUTPUT_TOKENS
  );
  const maxTokens = parseRequiredInteger(
    environment[AI_RUNTIME_MAX_TOKENS_ENV_NAME],
    MAX_PROVIDER_OUTPUT_TOKENS
  );

  if (
    !allowedModels ||
    defaultMaxTokens === null ||
    maxTokens === null ||
    defaultMaxTokens > maxTokens
  ) {
    return null;
  }

  return Object.freeze({
    allowedModels,
    defaultMaxTokens,
    maxTokens
  });
}
