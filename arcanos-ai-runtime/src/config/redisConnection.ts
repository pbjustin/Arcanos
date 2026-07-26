import type { RedisOptions } from "bullmq";

const DEFAULT_REDIS_PORT = 6379;
const REDIS_CONNECT_TIMEOUT_MS = 3000;
const REDIS_COMMAND_TIMEOUT_MS = 2000;
const PRODUCER_RECONNECT_BASE_DELAY_MS = 250;
const REDIS_RECONNECT_MAX_DELAY_MS = 5000;
const MAX_REDIS_URL_LENGTH = 4096;
const MAX_REDIS_HOST_LENGTH = 253;
const REDIS_DATABASE_PATH_PATTERN = /^\/\d+$/u;
const CONTROL_OR_WHITESPACE_PATTERN = /[\u0000-\u0020\u007f]/u;

export type RuntimeRedisConnectionProfile =
  | "producer"
  | "worker";

type RuntimeRedisTarget =
  | Readonly<{ url: string }>
  | Readonly<{ host: string; port: number }>;

function readTrimmedEnvironmentValue(
  environment: NodeJS.ProcessEnv,
  name: string
): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function parseRedisPort(
  environment: NodeJS.ProcessEnv
): number {
  const rawPort = readTrimmedEnvironmentValue(
    environment,
    "REDIS_PORT"
  );
  if (!rawPort) {
    return DEFAULT_REDIS_PORT;
  }
  const port = Number(rawPort);
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error("Invalid standalone AI runtime Redis port");
  }
  return port;
}

function resolveRedisUrl(
  environment: NodeJS.ProcessEnv
): string | undefined {
  const rawUrl = environment.AI_RUNTIME_REDIS_URL;
  if (rawUrl === undefined) {
    return undefined;
  }
  if (
    rawUrl.length === 0 ||
    rawUrl.length > MAX_REDIS_URL_LENGTH ||
    rawUrl !== rawUrl.trim() ||
    CONTROL_OR_WHITESPACE_PATTERN.test(rawUrl)
  ) {
    throw new Error(
      "Invalid standalone AI runtime Redis URL"
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(
      "Invalid standalone AI runtime Redis URL"
    );
  }
  if (
    (parsedUrl.protocol !== "redis:" &&
      parsedUrl.protocol !== "rediss:") ||
    parsedUrl.hostname.length === 0 ||
    parsedUrl.search.length > 0 ||
    parsedUrl.hash.length > 0 ||
    (parsedUrl.pathname !== "" &&
      parsedUrl.pathname !== "/" &&
      !REDIS_DATABASE_PATH_PATTERN.test(parsedUrl.pathname))
  ) {
    throw new Error(
      "Invalid standalone AI runtime Redis URL"
    );
  }
  return parsedUrl.toString();
}

function resolveRuntimeRedisTarget(
  environment: NodeJS.ProcessEnv
): RuntimeRedisTarget {
  const url = resolveRedisUrl(environment);
  if (url) {
    return Object.freeze({ url });
  }

  const host = readTrimmedEnvironmentValue(
    environment,
    "REDIS_HOST"
  );
  if (!host) {
    throw new Error(
      "Standalone AI runtime Redis configuration is unavailable"
    );
  }
  if (
    host.length > MAX_REDIS_HOST_LENGTH ||
    CONTROL_OR_WHITESPACE_PATTERN.test(host)
  ) {
    throw new Error(
      "Invalid standalone AI runtime Redis host"
    );
  }
  return Object.freeze({
    host,
    port: parseRedisPort(environment)
  });
}

function cappedReconnectDelay(attempt: number): number {
  return Math.min(
    2 ** Math.min(Math.max(attempt - 1, 0), 6) *
      PRODUCER_RECONNECT_BASE_DELAY_MS,
    REDIS_RECONNECT_MAX_DELAY_MS
  );
}

export function resolveRuntimeRedisConnection(
  environment: NodeJS.ProcessEnv,
  profile: RuntimeRedisConnectionProfile
): RedisOptions {
  const target = resolveRuntimeRedisTarget(environment);
  if (profile === "producer") {
    return {
      ...target,
      autoResendUnfulfilledCommands: false,
      commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
      connectionName: "arcanos-ai-runtime-producer",
      enableOfflineQueue: false,
      enableReadyCheck: true,
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      retryStrategy: cappedReconnectDelay
    };
  }
  if (profile !== "worker") {
    throw new Error(
      "Invalid standalone AI runtime Redis connection profile"
    );
  }
  return {
    ...target,
    autoResendUnfulfilledCommands: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    connectionName: "arcanos-ai-runtime-worker",
    enableOfflineQueue: true,
    enableReadyCheck: true,
    lazyConnect: false,
    maxRetriesPerRequest: null,
    retryStrategy: cappedReconnectDelay
  };
}
