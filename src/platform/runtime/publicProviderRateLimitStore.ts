import { createHash, randomUUID } from 'node:crypto';

import { DependencyUnavailableError } from '@platform/runtime/dependencyLifecycle.js';
import {
  executeRedisOperation,
  getRedisLifecycleSnapshot,
  type RedisLifecycleClient,
  type RedisLifecycleSnapshot,
  type RedisOperationOptions,
} from '@platform/runtime/redisLifecycle.js';
import type { PublicProviderRateLimitStoreMode } from '@platform/runtime/publicProviderRateLimitPolicy.js';

export type PublicProviderRateLimitTier = 'client' | 'global';

export interface PublicProviderRateLimitCounterSnapshot {
  limit: number;
  remaining: number;
  retryAfterMs: number;
  resetTimeMs: number;
}

export interface PublicProviderRateLimitDecision {
  allowed: boolean;
  limitedTier: PublicProviderRateLimitTier | null;
  client: PublicProviderRateLimitCounterSnapshot;
  clientSnapshotFresh?: boolean;
  global: PublicProviderRateLimitCounterSnapshot;
  globalSnapshotFresh?: boolean;
}

export interface PublicProviderRateLimitConsumeInput {
  clientIdentity: string;
  clientMaximum: number;
  globalMaximum: number;
  windowMs: number;
  requestId?: string;
  traceId?: string;
}

export interface PublicProviderRateLimitStore {
  consume(input: PublicProviderRateLimitConsumeInput): Promise<PublicProviderRateLimitDecision>;
}

export interface PublicProviderRateLimitCapabilityGate {
  getRevision(): number;
  isFailedGeneration(generation: number): boolean;
  markFailedGeneration(generation: number): void;
  markReadyGeneration(generation: number): void;
}

export function createPublicProviderRateLimitCapabilityGate():
PublicProviderRateLimitCapabilityGate {
  let failedGeneration: number | null = null;
  let revision = 0;
  return {
    getRevision: () => revision,
    isFailedGeneration: (generation) => failedGeneration === generation,
    markFailedGeneration(generation): void {
      failedGeneration = generation;
      revision += 1;
    },
    markReadyGeneration(generation): void {
      if (failedGeneration !== null && generation >= failedGeneration) {
        failedGeneration = null;
        revision += 1;
      }
    },
  };
}

export const publicProviderRateLimitCapabilityGate =
  createPublicProviderRateLimitCapabilityGate();

interface InMemoryRateLimitEntry {
  count: number;
  resetTimeMs: number;
}

interface CachedPublicProviderDenial {
  cacheExpiresAtMs: number;
  decision: PublicProviderRateLimitDecision;
  denialExpiresAtMs: number;
  policyKey: string;
  readyGeneration: number;
}

interface InMemoryPublicProviderRateLimitStoreOptions {
  now?: () => number;
}

interface RedisPublicProviderRateLimitStoreOptions {
  capabilityGate?: PublicProviderRateLimitCapabilityGate;
  denialCacheMaximumEntries?: number;
  getRedisSnapshot?: () => Pick<RedisLifecycleSnapshot, 'state' | 'readyGeneration'>;
  namespace: string;
  now?: () => number;
  onCapabilityFailure?: (expectedReadyGeneration: number) => void;
  execute?: typeof executeRedisOperation;
  redisOperationStartMaximum?: number;
}

interface RedisPublicProviderRateLimitCapabilityProbeOptions {
  execute?: typeof executeRedisOperation;
  probeId?: string;
}

export interface ConfiguredPublicProviderRateLimitStoreOptions {
  mode: PublicProviderRateLimitStoreMode;
  namespace: string | null;
  onCapabilityFailure?: (expectedReadyGeneration: number) => void;
}

const REDIS_RATE_LIMIT_OPERATION: RedisOperationOptions['operation'] =
  'public_provider.rate_limit.consume';
const REDIS_RATE_LIMIT_PROBE_OPERATION: RedisOperationOptions['operation'] =
  'public_provider.rate_limit.probe';
const DEFAULT_REDIS_DENIAL_CACHE_MAXIMUM_ENTRIES = 10_000;
const DEFAULT_REDIS_DENIAL_CACHE_MAXIMUM_TTL_MS = 1000;
export const DEFAULT_PUBLIC_PROVIDER_REDIS_OPERATION_START_MAXIMUM = 100;
const PUBLIC_PROVIDER_REDIS_OPERATION_START_WINDOW_MS = 1000;

export class PublicProviderRedisOperationStartRateError extends Error {
  readonly maximum: number;
  readonly retryAfterMs: number;

  constructor(maximum: number, retryAfterMs: number) {
    super('Public provider Redis admission operation rate exceeded.');
    this.name = 'PublicProviderRedisOperationStartRateError';
    this.maximum = maximum;
    this.retryAfterMs = retryAfterMs;
  }
}

const CONSUME_HIERARCHICAL_RATE_LIMIT_SCRIPT = `
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local client_maximum = tonumber(ARGV[2])
local global_maximum = tonumber(ARGV[3])

local function read_counter(key)
  local raw_count = redis.call("GET", key)
  if not raw_count then
    return 0, window_ms, 0
  end
  local count = tonumber(raw_count)
  local ttl_ms = redis.call("PTTL", key)
  if not count or count < 1 or count ~= math.floor(count) or ttl_ms < 1 then
    return 0, 0, 1
  end
  return count, ttl_ms, 0
end

local client_count, client_ttl_ms, client_invalid = read_counter(KEYS[1])
local global_count, global_ttl_ms, global_invalid = read_counter(KEYS[2])

if client_invalid == 1 or global_invalid == 1 then
  return {-1, 3, client_count, client_ttl_ms, global_count, global_ttl_ms, now_ms}
end

if client_maximum == global_maximum and global_count >= global_maximum then
  return {0, 2, client_count, client_ttl_ms, global_count, global_ttl_ms, now_ms}
end

if client_count >= client_maximum then
  return {0, 1, client_count, client_ttl_ms, global_count, global_ttl_ms, now_ms}
end

if global_count >= global_maximum then
  return {0, 2, client_count, client_ttl_ms, global_count, global_ttl_ms, now_ms}
end

client_count = redis.call("INCR", KEYS[1])
if client_count == 1 then
  redis.call("PEXPIRE", KEYS[1], window_ms)
end
global_count = redis.call("INCR", KEYS[2])
if global_count == 1 then
  redis.call("PEXPIRE", KEYS[2], window_ms)
end

client_ttl_ms = redis.call("PTTL", KEYS[1])
global_ttl_ms = redis.call("PTTL", KEYS[2])
return {1, 0, client_count, client_ttl_ms, global_count, global_ttl_ms, now_ms}
`;

const PROBE_HIERARCHICAL_RATE_LIMIT_CAPABILITY_SCRIPT = `
local now_parts = redis.call("TIME")
local existing = redis.call("GET", KEYS[1])
local existing_ttl_ms = redis.call("PTTL", KEYS[1])
local preflight_expiry = redis.call("PEXPIRE", KEYS[1], 1000)

if existing or existing_ttl_ms ~= -2 or preflight_expiry ~= 0 then
  return {-1, -1, -1, -1}
end

local count = redis.call("INCR", KEYS[1])
local expiry_set = redis.call("PEXPIRE", KEYS[1], 1000)
local ttl_ms = redis.call("PTTL", KEYS[1])
local stored_count = tonumber(redis.call("GET", KEYS[1]))
redis.pcall("DEL", KEYS[1])

local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
return {count, expiry_set, ttl_ms, stored_count, now_ms}
`;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function snapshot(
  limit: number,
  count: number,
  resetTimeMs: number,
  retryAfterMs: number
): PublicProviderRateLimitCounterSnapshot {
  return {
    limit,
    remaining: Math.max(0, limit - count),
    retryAfterMs: Math.max(1, retryAfterMs),
    resetTimeMs,
  };
}

function readActiveMemoryEntry(
  entries: Map<string, InMemoryRateLimitEntry>,
  key: string,
  nowMs: number,
  windowMs: number
): InMemoryRateLimitEntry {
  const current = entries.get(key);
  if (!current || nowMs >= current.resetTimeMs) {
    return { count: 0, resetTimeMs: nowMs + windowMs };
  }
  return current;
}

/** Equivalent non-durable store for local development and deterministic tests. */
export function createInMemoryPublicProviderRateLimitStore(
  options: InMemoryPublicProviderRateLimitStoreOptions = {}
): PublicProviderRateLimitStore {
  const now = options.now ?? Date.now;
  const entries = new Map<string, InMemoryRateLimitEntry>();
  let lastCleanupAtMs = 0;

  function maybePurgeExpiredEntries(nowMs: number, windowMs: number): void {
    const cleanupIntervalMs = Math.max(1000, Math.min(windowMs, 60 * 1000));
    if (nowMs - lastCleanupAtMs < cleanupIntervalMs) {
      return;
    }
    for (const [key, entry] of entries.entries()) {
      if (nowMs >= entry.resetTimeMs) {
        entries.delete(key);
      }
    }
    lastCleanupAtMs = nowMs;
  }

  return {
    async consume(input): Promise<PublicProviderRateLimitDecision> {
      const nowMs = now();
      maybePurgeExpiredEntries(nowMs, input.windowMs);
      const clientKey = `client:${digest(input.clientIdentity)}`;
      const globalKey = 'global';
      const clientEntry = readActiveMemoryEntry(entries, clientKey, nowMs, input.windowMs);
      const globalEntry = readActiveMemoryEntry(entries, globalKey, nowMs, input.windowMs);

      if (
        input.clientMaximum === input.globalMaximum
        && globalEntry.count >= input.globalMaximum
      ) {
        return {
          allowed: false,
          limitedTier: 'global',
          client: snapshot(
            input.clientMaximum,
            clientEntry.count,
            clientEntry.resetTimeMs,
            clientEntry.resetTimeMs - nowMs
          ),
          global: snapshot(
            input.globalMaximum,
            globalEntry.count,
            globalEntry.resetTimeMs,
            globalEntry.resetTimeMs - nowMs
          ),
        };
      }

      if (clientEntry.count >= input.clientMaximum) {
        return {
          allowed: false,
          limitedTier: 'client',
          client: snapshot(
            input.clientMaximum,
            clientEntry.count,
            clientEntry.resetTimeMs,
            clientEntry.resetTimeMs - nowMs
          ),
          global: snapshot(
            input.globalMaximum,
            globalEntry.count,
            globalEntry.resetTimeMs,
            globalEntry.resetTimeMs - nowMs
          ),
        };
      }

      if (globalEntry.count >= input.globalMaximum) {
        return {
          allowed: false,
          limitedTier: 'global',
          client: snapshot(
            input.clientMaximum,
            clientEntry.count,
            clientEntry.resetTimeMs,
            clientEntry.resetTimeMs - nowMs
          ),
          global: snapshot(
            input.globalMaximum,
            globalEntry.count,
            globalEntry.resetTimeMs,
            globalEntry.resetTimeMs - nowMs
          ),
        };
      }

      clientEntry.count += 1;
      globalEntry.count += 1;
      entries.set(clientKey, clientEntry);
      entries.set(globalKey, globalEntry);
      return {
        allowed: true,
        limitedTier: null,
        client: snapshot(
          input.clientMaximum,
          clientEntry.count,
          clientEntry.resetTimeMs,
          clientEntry.resetTimeMs - nowMs
        ),
        global: snapshot(
          input.globalMaximum,
          globalEntry.count,
          globalEntry.resetTimeMs,
          globalEntry.resetTimeMs - nowMs
        ),
      };
    },
  };
}

function parseRedisInteger(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^-?\d+$/u.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function redisDependencyUnavailable(): DependencyUnavailableError {
  return new DependencyUnavailableError(
    'redis',
    'REDIS_DEPENDENCY_UNAVAILABLE',
    'Redis dependency is unavailable.'
  );
}

function parseRedisDecision(
  result: unknown,
  input: PublicProviderRateLimitConsumeInput
): PublicProviderRateLimitDecision {
  if (!Array.isArray(result) || result.length !== 7) {
    throw redisDependencyUnavailable();
  }

  const values = result.map(parseRedisInteger);
  if (values.some((value) => value === null)) {
    throw redisDependencyUnavailable();
  }

  const [allowed, limitedTier, clientCount, clientTtlMs, globalCount, globalTtlMs, nowMs] =
    values as number[];
  if (
    (allowed !== 0 && allowed !== 1)
    || ![0, 1, 2].includes(limitedTier)
    || (allowed === 1 && limitedTier !== 0)
    || (allowed === 0 && limitedTier === 0)
    || clientCount < 0
    || globalCount < 0
    || clientTtlMs < 1
    || globalTtlMs < 1
    || nowMs < 1
    || (allowed === 1 && (
      clientCount < 1
      || clientCount > input.clientMaximum
      || globalCount < 1
      || globalCount > input.globalMaximum
    ))
    || (limitedTier === 1 && clientCount < input.clientMaximum)
    || (limitedTier === 2 && globalCount < input.globalMaximum)
  ) {
    throw redisDependencyUnavailable();
  }

  return {
    allowed: allowed === 1,
    limitedTier: limitedTier === 1 ? 'client' : limitedTier === 2 ? 'global' : null,
    client: snapshot(input.clientMaximum, clientCount, nowMs + clientTtlMs, clientTtlMs),
    global: snapshot(input.globalMaximum, globalCount, nowMs + globalTtlMs, globalTtlMs),
  };
}

function denialPolicyKey(input: PublicProviderRateLimitConsumeInput): string {
  return `${input.clientMaximum}:${input.globalMaximum}:${input.windowMs}`;
}

function readCachedDenial(
  cached: CachedPublicProviderDenial | undefined,
  input: PublicProviderRateLimitConsumeInput,
  nowMs: number,
  readyGeneration: number
): PublicProviderRateLimitDecision | null {
  if (
    !cached
    || cached.policyKey !== denialPolicyKey(input)
    || cached.readyGeneration !== readyGeneration
    || nowMs >= cached.cacheExpiresAtMs
  ) {
    return null;
  }
  const retryAfterMs = Math.max(1, cached.denialExpiresAtMs - nowMs);
  return {
    ...cached.decision,
    client: {
      ...cached.decision.client,
      retryAfterMs: cached.decision.limitedTier === 'client'
        ? retryAfterMs
        : cached.decision.client.retryAfterMs,
    },
    global: {
      ...cached.decision.global,
      retryAfterMs: cached.decision.limitedTier === 'global'
        ? retryAfterMs
        : cached.decision.global.retryAfterMs,
    },
  };
}

function cacheDenial(
  decision: PublicProviderRateLimitDecision,
  input: PublicProviderRateLimitConsumeInput,
  startedAtMs: number,
  completedAtMs: number,
  readyGeneration: number
): CachedPublicProviderDenial | null {
  if (decision.allowed || decision.limitedTier === null) {
    return null;
  }
  const limitedSnapshot = decision.limitedTier === 'client'
    ? decision.client
    : decision.global;
  const elapsedMs = Math.max(0, completedAtMs - startedAtMs);
  const remainingTtlMs = limitedSnapshot.retryAfterMs - elapsedMs;
  if (remainingTtlMs <= 0) {
    return null;
  }
  const denialExpiresAtMs = completedAtMs + remainingTtlMs;
  return {
    cacheExpiresAtMs: Math.min(
      denialExpiresAtMs,
      completedAtMs + DEFAULT_REDIS_DENIAL_CACHE_MAXIMUM_TTL_MS
    ),
    decision,
    denialExpiresAtMs,
    policyKey: denialPolicyKey(input),
    readyGeneration,
  };
}

/** Shared Redis store used by every production web replica. */
export function createRedisPublicProviderRateLimitStore(
  options: RedisPublicProviderRateLimitStoreOptions
): PublicProviderRateLimitStore {
  const now = options.now ?? Date.now;
  const denialCacheMaximumEntries = Number.isSafeInteger(options.denialCacheMaximumEntries)
    && Number(options.denialCacheMaximumEntries) >= 1
    ? Math.min(
      Number(options.denialCacheMaximumEntries),
      DEFAULT_REDIS_DENIAL_CACHE_MAXIMUM_ENTRIES
    )
    : DEFAULT_REDIS_DENIAL_CACHE_MAXIMUM_ENTRIES;
  const redisOperationStartMaximum = Number.isSafeInteger(
    options.redisOperationStartMaximum
  ) && Number(options.redisOperationStartMaximum) >= 1
    ? Math.min(
      Number(options.redisOperationStartMaximum),
      DEFAULT_PUBLIC_PROVIDER_REDIS_OPERATION_START_MAXIMUM
    )
    : DEFAULT_PUBLIC_PROVIDER_REDIS_OPERATION_START_MAXIMUM;
  const getRedisSnapshot = options.getRedisSnapshot
    ?? (options.execute ? null : getRedisLifecycleSnapshot);
  const capabilityGate = options.capabilityGate;
  const namespaceDigest = digest(options.namespace).slice(0, 32);
  const keyPrefix = `arcanos:public-provider:v1:{${namespaceDigest}}`;
  const globalKey = `${keyPrefix}:global`;
  const clientDenials = new Map<string, CachedPublicProviderDenial>();
  let globalDenial: CachedPublicProviderDenial | null = null;
  let denialCacheGeneration: number | null = null;
  let denialCacheRevision = 0;
  let observedCapabilityGateRevision = capabilityGate?.getRevision() ?? 0;
  let redisOperationStartTokens = redisOperationStartMaximum;
  let redisOperationLastRefillAtMs: number | null = null;

  const readReadyGeneration = (): number | null => {
    if (!getRedisSnapshot) {
      return 0;
    }
    const snapshot = getRedisSnapshot();
    return snapshot.state === 'READY' ? snapshot.readyGeneration : null;
  };

  const synchronizeDenialCacheGeneration = (readyGeneration: number | null): void => {
    if (readyGeneration === null || denialCacheGeneration !== readyGeneration) {
      clientDenials.clear();
      globalDenial = null;
      denialCacheGeneration = readyGeneration;
    }
  };

  const claimRedisOperationStart = (nowMs: number): void => {
    if (redisOperationLastRefillAtMs === null) {
      redisOperationLastRefillAtMs = nowMs;
    } else {
      const elapsedMs = Math.max(0, nowMs - redisOperationLastRefillAtMs);
      if (elapsedMs > 0) {
        redisOperationStartTokens = Math.min(
          redisOperationStartMaximum,
          redisOperationStartTokens
            + (elapsedMs * redisOperationStartMaximum
              / PUBLIC_PROVIDER_REDIS_OPERATION_START_WINDOW_MS)
        );
        redisOperationLastRefillAtMs = nowMs;
      }
    }
    if (redisOperationStartTokens < 1) {
      const retryAfterMs = Math.max(
        1,
        Math.ceil(
          ((1 - redisOperationStartTokens)
            * PUBLIC_PROVIDER_REDIS_OPERATION_START_WINDOW_MS)
          / redisOperationStartMaximum
        )
      );
      throw new PublicProviderRedisOperationStartRateError(
        redisOperationStartMaximum,
        retryAfterMs
      );
    }
    redisOperationStartTokens -= 1;
  };

  const setClientDenial = (
    clientKey: string,
    cached: CachedPublicProviderDenial
  ): void => {
    clientDenials.delete(clientKey);
    while (clientDenials.size >= denialCacheMaximumEntries) {
      const oldestKey = clientDenials.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      clientDenials.delete(oldestKey);
    }
    clientDenials.set(clientKey, cached);
  };

  return {
    async consume(input): Promise<PublicProviderRateLimitDecision> {
      const clientKey = `${keyPrefix}:client:${digest(input.clientIdentity)}`;
      const lookupAtMs = now();
      const startedReadyGeneration = readReadyGeneration();
      const capabilityGateRevision = capabilityGate?.getRevision()
        ?? observedCapabilityGateRevision;
      if (capabilityGateRevision !== observedCapabilityGateRevision) {
        clientDenials.clear();
        globalDenial = null;
        denialCacheGeneration = null;
        denialCacheRevision += 1;
        observedCapabilityGateRevision = capabilityGateRevision;
      }
      synchronizeDenialCacheGeneration(startedReadyGeneration);
      if (
        startedReadyGeneration !== null
        && capabilityGate?.isFailedGeneration(startedReadyGeneration)
      ) {
        throw redisDependencyUnavailable();
      }
      const startedDenialCacheRevision = denialCacheRevision;
      if (startedReadyGeneration !== null) {
        const cachedGlobalDecision = readCachedDenial(
          globalDenial ?? undefined,
          input,
          lookupAtMs,
          startedReadyGeneration
        );
        if (cachedGlobalDecision) {
          return { ...cachedGlobalDecision, clientSnapshotFresh: false };
        }
        globalDenial = null;

        const cachedClientDecision = readCachedDenial(
          clientDenials.get(clientKey),
          input,
          lookupAtMs,
          startedReadyGeneration
        );
        if (cachedClientDecision) {
          return { ...cachedClientDecision, globalSnapshotFresh: false };
        }
      }
      clientDenials.delete(clientKey);

      const operation = async (client: RedisLifecycleClient) => parseRedisDecision(
        await client.eval(
          CONSUME_HIERARCHICAL_RATE_LIMIT_SCRIPT,
          {
            keys: [clientKey, globalKey],
            arguments: [
              String(input.windowMs),
              String(input.clientMaximum),
              String(input.globalMaximum),
            ],
          }
        ),
        input
      );
      const startedAtMs = now();
      if (startedReadyGeneration !== null) {
        claimRedisOperationStart(startedAtMs);
      }
      let decision: PublicProviderRateLimitDecision;
      try {
        decision = options.execute
          ? await options.execute(operation, {
            operation: REDIS_RATE_LIMIT_OPERATION,
            requestId: input.requestId,
            traceId: input.traceId,
          })
          : await executeRedisOperation(operation, {
            operation: REDIS_RATE_LIMIT_OPERATION,
            requestId: input.requestId,
            traceId: input.traceId,
          });
      } catch (error) {
        const failedReadyGeneration = readReadyGeneration();
        if (
          startedReadyGeneration !== null
          && failedReadyGeneration === startedReadyGeneration
        ) {
          clientDenials.clear();
          globalDenial = null;
          denialCacheGeneration = null;
          denialCacheRevision += 1;
          capabilityGate?.markFailedGeneration(startedReadyGeneration);
          observedCapabilityGateRevision = capabilityGate?.getRevision()
            ?? observedCapabilityGateRevision;
          options.onCapabilityFailure?.(startedReadyGeneration);
        }
        throw error;
      }
      const completedAtMs = now();
      const completedReadyGeneration = readReadyGeneration();
      synchronizeDenialCacheGeneration(completedReadyGeneration);
      const cached = startedReadyGeneration !== null
        && completedReadyGeneration === startedReadyGeneration
        && denialCacheRevision === startedDenialCacheRevision
        ? cacheDenial(
          decision,
          input,
          startedAtMs,
          completedAtMs,
          completedReadyGeneration
        )
        : null;
      if (cached) {
        if (decision.limitedTier === 'global') {
          globalDenial = cached;
        } else {
          setClientDenial(clientKey, cached);
        }
      }
      return decision;
    },
  };
}

function parseRedisCapabilityProbe(result: unknown): void {
  if (!Array.isArray(result) || result.length !== 5) {
    throw redisDependencyUnavailable();
  }
  const values = result.map(parseRedisInteger);
  if (values.some((value) => value === null)) {
    throw redisDependencyUnavailable();
  }
  const [count, expirySet, ttlMs, storedCount, nowMs] = values as number[];
  if (
    count !== 1
    || expirySet !== 1
    || ttlMs < 1
    || ttlMs > 1000
    || storedCount !== count
    || nowMs < 1
  ) {
    throw redisDependencyUnavailable();
  }
}

/** Verify the exact Redis command family used by admission without touching live counters. */
export async function probeRedisPublicProviderRateLimitCapability(
  namespace: string,
  options: RedisPublicProviderRateLimitCapabilityProbeOptions = {}
): Promise<void> {
  const namespaceDigest = digest(namespace).slice(0, 32);
  const probeId = digest(options.probeId ?? randomUUID()).slice(0, 32);
  const probeKey = `arcanos:public-provider:v1:{${namespaceDigest}}:capability:${probeId}`;
  const operation = async (client: RedisLifecycleClient): Promise<void> => {
    parseRedisCapabilityProbe(await client.eval(
      PROBE_HIERARCHICAL_RATE_LIMIT_CAPABILITY_SCRIPT,
      { keys: [probeKey], arguments: [] }
    ));
  };
  if (options.execute) {
    await options.execute(operation, { operation: REDIS_RATE_LIMIT_PROBE_OPERATION });
    return;
  }
  await executeRedisOperation(operation, { operation: REDIS_RATE_LIMIT_PROBE_OPERATION });
}

function createUnavailableRedisStore(): PublicProviderRateLimitStore {
  return {
    async consume(): Promise<PublicProviderRateLimitDecision> {
      throw redisDependencyUnavailable();
    },
  };
}

export function createConfiguredPublicProviderRateLimitStore(
  options: ConfiguredPublicProviderRateLimitStoreOptions
): PublicProviderRateLimitStore {
  if (options.mode === 'memory') {
    return createInMemoryPublicProviderRateLimitStore();
  }

  return options.namespace
    ? createRedisPublicProviderRateLimitStore({
      capabilityGate: publicProviderRateLimitCapabilityGate,
      namespace: options.namespace,
      onCapabilityFailure: options.onCapabilityFailure,
    })
    : createUnavailableRedisStore();
}
