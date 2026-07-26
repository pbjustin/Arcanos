export const AI_RUNTIME_QUEUE_NAME_ENV_NAME =
  "AI_RUNTIME_QUEUE_NAME";

const RUNTIME_QUEUE_NAME_PATTERN =
  /^[a-z0-9][a-z0-9_-]{0,63}$/u;

export function isValidRuntimeQueueName(
  value: string
): boolean {
  return RUNTIME_QUEUE_NAME_PATTERN.test(value);
}

export function resolveRuntimeQueueName(
  environment: NodeJS.ProcessEnv
): string {
  const rawName =
    environment[AI_RUNTIME_QUEUE_NAME_ENV_NAME];
  if (
    typeof rawName !== "string" ||
    rawName.length === 0 ||
    rawName !== rawName.trim() ||
    !isValidRuntimeQueueName(rawName)
  ) {
    throw new Error(
      "AI runtime queue name configuration is unavailable"
    );
  }
  return rawName;
}
