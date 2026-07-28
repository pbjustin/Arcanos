import { createHash, randomUUID } from "node:crypto";

import {
  isValidRuntimeQueueName
} from "../config/queueName.js";
import type { RuntimeAdmissionConfig } from "./config.js";
import type {
  RuntimeAdmissionReconciliationPort,
  RuntimeConfirmationDecision,
  RuntimeExecutionClaim,
  RuntimeMissingObservation,
  RuntimeRateDecision,
  RuntimeReconciliationCandidate,
  RuntimeReservationDecision
} from "./types.js";

const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

interface RuntimeAdmissionRedisClient {
  eval(
    script: string,
    numberOfKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
}

export interface RedisRuntimeAdmissionOptions {
  getClient: () => Promise<RuntimeAdmissionRedisClient>;
  config: RuntimeAdmissionConfig;
  queueName: string;
  generateAttemptId?: () => string;
}

const CONSUME_RATE_SCRIPT = `
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local window_ms = tonumber(ARGV[1])
local maximum = tonumber(ARGV[2])
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", now_ms - window_ms)
local count = redis.call("ZCARD", KEYS[1])
if count >= maximum then
  local oldest = redis.call("ZRANGE", KEYS[1], 0, 0, "WITHSCORES")
  local retry_ms = window_ms
  if oldest[2] then
    retry_ms = math.max(1, math.ceil(tonumber(oldest[2]) + window_ms - now_ms))
  end
  return {0, retry_ms}
end
redis.call("ZADD", KEYS[1], now_ms, ARGV[3])
redis.call("PEXPIRE", KEYS[1], window_ms)
return {1, 0}
`;

const RESERVE_SCRIPT = `
local outstanding = redis.call("HLEN", KEYS[1])
local maximum = tonumber(ARGV[3])
if outstanding >= maximum then
  return {0}
end
if redis.call("HEXISTS", KEYS[1], ARGV[1]) == 1 then
  return {-1}
end
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
redis.call("HSET", KEYS[1], ARGV[1], "pending|" .. ARGV[2] .. "|" .. now_ms)
redis.call("ZADD", KEYS[2], now_ms, ARGV[1])
return {1}
`;

const CONFIRM_SCRIPT = `
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then
  return {0}
end
local pending_prefix = "pending|" .. ARGV[2] .. "|"
local confirmed_prefix = "confirmed|" .. ARGV[2] .. "|"
local claimed_prefix = "claimed|" .. ARGV[2] .. "|"
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
if string.sub(value, 1, string.len(pending_prefix)) == pending_prefix then
  local suffix = string.sub(value, string.len(pending_prefix) + 1)
  redis.call("HSET", KEYS[1], ARGV[1], confirmed_prefix .. suffix)
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZADD", KEYS[3], now_ms, ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {1}
end
if string.sub(value, 1, string.len(confirmed_prefix)) == confirmed_prefix
  or string.sub(value, 1, string.len(claimed_prefix)) == claimed_prefix then
  redis.call("ZADD", KEYS[3], now_ms, ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {2}
end
return {-1}
`;

const CLAIM_SCRIPT = `
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then
  return {0}
end
local pending_prefix = "pending|" .. ARGV[2] .. "|"
local confirmed_prefix = "confirmed|" .. ARGV[2] .. "|"
local claimed_prefix = "claimed|" .. ARGV[2] .. "|"
local suffix = nil
if string.sub(value, 1, string.len(pending_prefix)) == pending_prefix then
  suffix = string.sub(value, string.len(pending_prefix) + 1)
elseif string.sub(value, 1, string.len(confirmed_prefix)) == confirmed_prefix then
  suffix = string.sub(value, string.len(confirmed_prefix) + 1)
elseif string.sub(value, 1, string.len(claimed_prefix)) == claimed_prefix then
  return {2}
else
  return {-1}
end
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
redis.call("HSET", KEYS[1], ARGV[1], claimed_prefix .. ARGV[3] .. "|" .. suffix)
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZADD", KEYS[3], now_ms, ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
return {1}
`;

const RELEASE_CLAIM_SCRIPT = `
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {0}
end
local claim_prefix = "claimed|" .. ARGV[2] .. "|" .. ARGV[3] .. "|"
if string.sub(value, 1, string.len(claim_prefix)) ~= claim_prefix then
  return {-1}
end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
return {1}
`;

const RELEASE_RECONCILED_SCRIPT = `
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {0}
end
local owner_marker = "|" .. ARGV[2] .. "|"
if not string.find(value, owner_marker, 1, true) then
  return {-1}
end
redis.call("HDEL", KEYS[1], ARGV[1])
redis.call("ZREM", KEYS[2], ARGV[1])
redis.call("ZREM", KEYS[3], ARGV[1])
redis.call("ZREM", KEYS[4], ARGV[1])
return {1}
`;

const LIST_RECONCILIATION_CANDIDATES_SCRIPT = `
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local pending_cutoff = now_ms - tonumber(ARGV[1])
local live_cutoff = now_ms - tonumber(ARGV[2])
local maximum = tonumber(ARGV[3])
local result = {}
local pending = redis.call("ZRANGEBYSCORE", KEYS[1], "-inf", pending_cutoff, "LIMIT", 0, maximum)
for _, job_id in ipairs(pending) do
  table.insert(result, job_id)
  table.insert(result, "pending")
end
local remaining = maximum - #pending
if remaining > 0 then
  local live = redis.call("ZRANGEBYSCORE", KEYS[2], "-inf", live_cutoff, "LIMIT", 0, remaining)
  for _, job_id in ipairs(live) do
    table.insert(result, job_id)
    table.insert(result, "live")
  end
end
return result
`;

const OBSERVE_MISSING_SCRIPT = `
local value = redis.call("HGET", KEYS[1], ARGV[1])
if not value then
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {0}
end
local owner_marker = "|" .. ARGV[2] .. "|"
if not string.find(value, owner_marker, 1, true) then
  return {-1}
end
local now_parts = redis.call("TIME")
local now_ms = (tonumber(now_parts[1]) * 1000) + math.floor(tonumber(now_parts[2]) / 1000)
local first_missing = redis.call("ZSCORE", KEYS[4], ARGV[1])
if first_missing and now_ms - tonumber(first_missing) >= tonumber(ARGV[3]) then
  redis.call("HDEL", KEYS[1], ARGV[1])
  redis.call("ZREM", KEYS[2], ARGV[1])
  redis.call("ZREM", KEYS[3], ARGV[1])
  redis.call("ZREM", KEYS[4], ARGV[1])
  return {2}
end
if not first_missing then
  redis.call("ZADD", KEYS[4], now_ms, ARGV[1])
end
if redis.call("ZSCORE", KEYS[2], ARGV[1]) then
  redis.call("ZADD", KEYS[2], now_ms, ARGV[1])
end
if redis.call("ZSCORE", KEYS[3], ARGV[1]) then
  redis.call("ZADD", KEYS[3], now_ms, ARGV[1])
end
if first_missing then
  return {3}
end
return {1}
`;

function digestPrincipal(principalId: string): string {
  return createHash("sha256").update(principalId, "utf8").digest("hex");
}

function parseIntegerResult(
  result: unknown,
  operation: string,
  expectedLength: number
): number[] {
  if (
    !Array.isArray(result) ||
    result.length !== expectedLength
  ) {
    throw new Error(`Invalid Redis admission ${operation} response`);
  }

  if (
    result.some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value)
    )
  ) {
    throw new Error(`Invalid Redis admission ${operation} response`);
  }
  return result;
}

function sanitizeRetryAfterMs(value: number | undefined): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
    ? value
    : 1000;
}

export function createRedisRuntimeAdmission(
  options: RedisRuntimeAdmissionOptions
): RuntimeAdmissionReconciliationPort {
  const {
    config,
    generateAttemptId = randomUUID,
    getClient,
    queueName
  } = options;
  if (!isValidRuntimeQueueName(queueName)) {
    throw new Error("Invalid AI runtime admission queue name");
  }
  const keyPrefix =
    `arcanos:ai-runtime:admission:{${queueName}}`;
  const reservationsKey = `${keyPrefix}:reservations`;
  const pendingKey = `${keyPrefix}:pending`;
  const liveKey = `${keyPrefix}:live`;
  const missingKey = `${keyPrefix}:missing`;

  async function evalScript(
    script: string,
    keys: string[],
    args: Array<string | number>,
    expectedLength: number
  ): Promise<number[]> {
    const client = await getClient();
    const result = await client.eval(
      script,
      keys.length,
      ...keys,
      ...args
    );
    return parseIntegerResult(
      result,
      "script",
      expectedLength
    );
  }

  async function evalRaw(
    script: string,
    keys: string[],
    args: Array<string | number>
  ): Promise<unknown> {
    const client = await getClient();
    return client.eval(
      script,
      keys.length,
      ...keys,
      ...args
    );
  }

  return {
    async consumeEnqueueRate(
      principalId: string
    ): Promise<RuntimeRateDecision> {
      const principalDigest = digestPrincipal(principalId);
      const rateKey = `${keyPrefix}:rate:${principalDigest}`;
      const [decision, retryAfterMs] = await evalScript(
        CONSUME_RATE_SCRIPT,
        [rateKey],
        [
          config.rateWindowMs,
          config.rateMax,
          generateAttemptId()
        ],
        2
      );
      if (decision === 1) {
        return { kind: "allowed" };
      }
      if (decision === 0) {
        return {
          kind: "rate_limited",
          retryAfterMs: sanitizeRetryAfterMs(retryAfterMs)
        };
      }
      throw new Error("Invalid Redis admission rate decision");
    },

    async reserve(input): Promise<RuntimeReservationDecision> {
      if (!UUID_V4_PATTERN.test(input.jobId)) {
        throw new Error("Invalid AI runtime admission job ID");
      }
      const [decision] = await evalScript(
        RESERVE_SCRIPT,
        [reservationsKey, pendingKey],
        [
          input.jobId,
          digestPrincipal(input.principalId),
          config.maxOutstanding
        ],
        1
      );
      if (decision === 1) {
        return { kind: "granted" };
      }
      if (decision === 0) {
        return {
          kind: "saturated",
          retryAfterMs: Math.min(config.rateWindowMs, 5000)
        };
      }
      throw new Error("Redis admission reservation collision");
    },

    async confirmQueued(
      jobId,
      principalId
    ): Promise<RuntimeConfirmationDecision> {
      if (!UUID_V4_PATTERN.test(jobId)) {
        throw new Error("Invalid AI runtime admission job ID");
      }
      const [decision] = await evalScript(
        CONFIRM_SCRIPT,
        [reservationsKey, pendingKey, liveKey, missingKey],
        [jobId, digestPrincipal(principalId)],
        1
      );
      switch (decision) {
        case 1:
          return "confirmed";
        case 2:
          return "already_confirmed";
        case 0:
          return "already_released";
        case -1:
          return "wrong_owner";
        default:
          throw new Error("Invalid Redis admission confirmation decision");
      }
    },

    async claimForExecution(
      jobId,
      principalId,
      claimId
    ): Promise<RuntimeExecutionClaim> {
      if (!UUID_V4_PATTERN.test(jobId)) {
        throw new Error("Invalid AI runtime admission job ID");
      }
      if (!claimId || claimId.length > 4096) {
        throw new Error("Invalid AI runtime admission claim ID");
      }
      const [decision] = await evalScript(
        CLAIM_SCRIPT,
        [reservationsKey, pendingKey, liveKey, missingKey],
        [
          jobId,
          digestPrincipal(principalId),
          digestPrincipal(claimId)
        ],
        1
      );
      switch (decision) {
        case 1:
          return "claimed";
        case 2:
          return "already_claimed";
        case 0:
          return "missing";
        case -1:
          return "wrong_owner";
        default:
          throw new Error("Invalid Redis admission execution decision");
      }
    },

    async releaseTerminal(
      jobId,
      principalId,
      claimId
    ): Promise<void> {
      if (!UUID_V4_PATTERN.test(jobId)) {
        throw new Error("Invalid AI runtime admission job ID");
      }
      if (!claimId || claimId.length > 4096) {
        throw new Error("Invalid AI runtime admission claim ID");
      }
      const [decision] = await evalScript(
        RELEASE_CLAIM_SCRIPT,
        [reservationsKey, pendingKey, liveKey, missingKey],
        [
          jobId,
          digestPrincipal(principalId),
          digestPrincipal(claimId)
        ],
        1
      );
      if (decision !== 1 && decision !== 0) {
        throw new Error("Redis admission release ownership mismatch");
      }
    },

    async listReconciliationCandidates(input): Promise<
      RuntimeReconciliationCandidate[]
    > {
      const result = await evalRaw(
        LIST_RECONCILIATION_CANDIDATES_SCRIPT,
        [pendingKey, liveKey],
        [
          input.pendingGraceMs,
          input.liveGraceMs,
          input.batchSize
        ]
      );
      if (!Array.isArray(result) || result.length % 2 !== 0) {
        throw new Error(
          "Invalid Redis admission reconciliation response"
        );
      }

      const candidates: RuntimeReconciliationCandidate[] = [];
      for (let index = 0; index < result.length; index += 2) {
        const jobId = String(result[index] ?? "");
        const state = String(result[index + 1] ?? "");
        if (
          !UUID_V4_PATTERN.test(jobId) ||
          (state !== "pending" && state !== "live")
        ) {
          throw new Error(
            "Invalid Redis admission reconciliation response"
          );
        }
        candidates.push({ jobId, state });
      }
      return candidates;
    },

    async observeMissing(
      jobId,
      principalId,
      confirmationMs
    ): Promise<RuntimeMissingObservation> {
      if (
        !UUID_V4_PATTERN.test(jobId) ||
        !Number.isSafeInteger(confirmationMs) ||
        confirmationMs <= 0
      ) {
        throw new Error("Invalid AI runtime missing observation");
      }
      const [decision] = await evalScript(
        OBSERVE_MISSING_SCRIPT,
        [reservationsKey, pendingKey, liveKey, missingKey],
        [
          jobId,
          digestPrincipal(principalId),
          confirmationMs
        ],
        1
      );
      switch (decision) {
        case 2:
          return "released";
        case 1:
          return "first_observation";
        case 3:
          return "awaiting_confirmation";
        case 0:
          return "already_released";
        case -1:
          return "wrong_owner";
        default:
          throw new Error(
            "Invalid Redis admission missing observation decision"
          );
      }
    },

    async releaseReconciled(jobId, principalId): Promise<void> {
      if (!UUID_V4_PATTERN.test(jobId)) {
        throw new Error("Invalid AI runtime admission job ID");
      }
      const [decision] = await evalScript(
        RELEASE_RECONCILED_SCRIPT,
        [reservationsKey, pendingKey, liveKey, missingKey],
        [jobId, digestPrincipal(principalId)],
        1
      );
      if (decision !== 1 && decision !== 0) {
        throw new Error(
          "Redis admission reconciled release ownership mismatch"
        );
      }
    }
  };
}
