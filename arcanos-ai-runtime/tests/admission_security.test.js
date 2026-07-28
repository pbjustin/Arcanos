import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME,
  AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME,
  AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME,
  AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME,
  AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME,
  AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME,
  AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME,
  AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME,
  resolveRuntimeAdmissionConfig
} from "../dist/admission/config.js";
import {
  createRuntimeAdmissionReconciler
} from "../dist/admission/reconciler.js";
import {
  createRedisRuntimeAdmission
} from "../dist/admission/redisAdmission.js";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";
const PRINCIPAL_ID = "operator:runtime-test";
const ADMISSION_CONFIG = resolveRuntimeAdmissionConfig({
  [AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME]: "100",
  [AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME]: "60",
  [AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME]: "60000",
  [AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME]: "30000",
  [AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME]: "10000",
  [AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME]: "5000",
  [AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME]: "100",
  [AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME]: "180000"
});
assert.ok(ADMISSION_CONFIG);

function createFakeRedis(results) {
  const calls = [];
  return {
    calls,
    client: {
      async eval(...args) {
        calls.push(args);
        if (results.length === 0) {
          throw new Error("missing fake Redis result");
        }
        const result = results.shift();
        if (result instanceof Error) {
          throw result;
        }
        return result;
      }
    }
  };
}

function createAdmission(results) {
  const redis = createFakeRedis(results);
  const admission = createRedisRuntimeAdmission({
    config: ADMISSION_CONFIG,
    generateAttemptId: () =>
      "223e4567-e89b-42d3-a456-426614174000",
    getClient: async () => redis.client,
    queueName: "ai-jobs"
  });
  return { admission, redis };
}

describe("standalone AI runtime Redis admission", () => {
  it("requires explicit bounded admission configuration", () => {
    assert.equal(resolveRuntimeAdmissionConfig({}), null);
    assert.equal(
      resolveRuntimeAdmissionConfig({
        [AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME]: "0",
        [AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME]: "60",
        [AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME]: "60000",
        [AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME]: "30000",
        [AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME]: "10000",
        [AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME]: "5000",
        [AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME]: "100",
        [AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME]: "180000"
      }),
      null
    );
    assert.equal(
      resolveRuntimeAdmissionConfig({
        [AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME]: "100",
        [AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME]: "60",
        [AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME]: "999",
        [AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME]: "30000",
        [AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME]: "10000",
        [AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME]: "5000",
        [AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME]: "100",
        [AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME]: "180000"
      }),
      null
    );
    assert.equal(
      resolveRuntimeAdmissionConfig({
        [AI_RUNTIME_ADMISSION_MAX_OUTSTANDING_ENV_NAME]: "100",
        [AI_RUNTIME_ADMISSION_RATE_MAX_ENV_NAME]: "60",
        [AI_RUNTIME_ADMISSION_RATE_WINDOW_MS_ENV_NAME]: "60000",
        [AI_RUNTIME_ADMISSION_PENDING_GRACE_MS_ENV_NAME]: "30000",
        [AI_RUNTIME_ADMISSION_MISSING_CONFIRM_MS_ENV_NAME]: "10000",
        [AI_RUNTIME_ADMISSION_RECONCILE_INTERVAL_MS_ENV_NAME]: "5000",
        [AI_RUNTIME_ADMISSION_RECONCILE_BATCH_SIZE_ENV_NAME]: "100",
        [AI_RUNTIME_ADMISSION_CLAIM_GRACE_MS_ENV_NAME]: "120000"
      }),
      null
    );
    assert.equal(Object.isFrozen(ADMISSION_CONFIG), true);
  });

  it("maps the Redis rate, reservation, confirmation, claim, and release decisions", async () => {
    const { admission, redis } = createAdmission([
      [1, 0],
      [1],
      [1],
      [1],
      [1]
    ]);

    assert.deepEqual(
      await admission.consumeEnqueueRate(PRINCIPAL_ID),
      { kind: "allowed" }
    );
    assert.deepEqual(
      await admission.reserve({
        jobId: JOB_ID,
        principalId: PRINCIPAL_ID
      }),
      { kind: "granted" }
    );
    assert.equal(
      await admission.confirmQueued(JOB_ID, PRINCIPAL_ID),
      "confirmed"
    );
    assert.equal(
      await admission.claimForExecution(
        JOB_ID,
        PRINCIPAL_ID,
        "bullmq-claim-token"
      ),
      "claimed"
    );
    await admission.releaseTerminal(
      JOB_ID,
      PRINCIPAL_ID,
      "bullmq-claim-token"
    );

    assert.equal(redis.calls.length, 5);
    const serializedCalls = JSON.stringify(redis.calls);
    assert.equal(serializedCalls.includes(PRINCIPAL_ID), false);
    assert.match(serializedCalls, /[0-9a-f]{64}/u);
    for (const call of redis.calls) {
      assert.match(
        JSON.stringify(call),
        /arcanos:ai-runtime:admission:\{ai-jobs\}/u
      );
    }
  });

  it("reconciles queued, terminal, missing, and mismatched reservations", async () => {
    const operations = [];
    const jobs = new Map([
      [
        "123e4567-e89b-42d3-a456-426614174001",
        {
          data: { principalId: PRINCIPAL_ID },
          async getState() {
            return "waiting";
          }
        }
      ],
      [
        "123e4567-e89b-42d3-a456-426614174002",
        {
          data: { principalId: PRINCIPAL_ID },
          async getState() {
            return "completed";
          }
        }
      ],
      [
        "123e4567-e89b-42d3-a456-426614174004",
        {
          data: { principalId: "operator:other" },
          async getState() {
            return "waiting";
          }
        }
      ]
    ]);
    const admission = {
      async consumeEnqueueRate() {
        return { kind: "allowed" };
      },
      async reserve() {
        return { kind: "granted" };
      },
      async confirmQueued(jobId) {
        operations.push(["confirm", jobId]);
        return "confirmed";
      },
      async claimForExecution() {
        return "claimed";
      },
      async releaseTerminal(jobId) {
        operations.push(["release", jobId]);
      },
      async releaseReconciled(jobId) {
        operations.push(["release", jobId]);
      },
      async listReconciliationCandidates() {
        return [
          {
            jobId: "123e4567-e89b-42d3-a456-426614174001",
            state: "pending"
          },
          {
            jobId: "123e4567-e89b-42d3-a456-426614174002",
            state: "live"
          },
          {
            jobId: "123e4567-e89b-42d3-a456-426614174003",
            state: "pending"
          },
          {
            jobId: "123e4567-e89b-42d3-a456-426614174004",
            state: "live"
          }
        ];
      },
      async observeMissing(jobId) {
        operations.push(["missing", jobId]);
        return "first_observation";
      }
    };
    const reconciler = createRuntimeAdmissionReconciler({
      admission,
      config: ADMISSION_CONFIG,
      expectedPrincipalId: PRINCIPAL_ID,
      logger: {
        error(event) {
          operations.push(["log", event]);
        }
      },
      queue: {
        async getJob(jobId) {
          return jobs.get(jobId) ?? null;
        }
      }
    });

    await reconciler.runOnce();

    assert.deepEqual(operations, [
      [
        "confirm",
        "123e4567-e89b-42d3-a456-426614174001"
      ],
      [
        "release",
        "123e4567-e89b-42d3-a456-426614174002"
      ],
      [
        "missing",
        "123e4567-e89b-42d3-a456-426614174003"
      ],
      [
        "log",
        "ai_runtime.admission.reconcile_job_owner_mismatch"
      ],
      [
        "release",
        "123e4567-e89b-42d3-a456-426614174004"
      ]
    ]);
  });

  it("maps rate exhaustion and global saturation to bounded retry decisions", async () => {
    const { admission } = createAdmission([
      [0, 1500],
      [0]
    ]);

    assert.deepEqual(
      await admission.consumeEnqueueRate(PRINCIPAL_ID),
      { kind: "rate_limited", retryAfterMs: 1500 }
    );
    assert.deepEqual(
      await admission.reserve({
        jobId: JOB_ID,
        principalId: PRINCIPAL_ID
      }),
      { kind: "saturated", retryAfterMs: 5000 }
    );
  });

  it("maps bounded reconciliation candidates and missing observations", async () => {
    const secondJobId =
      "123e4567-e89b-42d3-a456-426614174001";
    const { admission } = createAdmission([
      [JOB_ID, "pending", secondJobId, "live"],
      [1],
      [3],
      [2],
      [0]
    ]);

    assert.deepEqual(
      await admission.listReconciliationCandidates({
        pendingGraceMs: 30000,
        liveGraceMs: 5000,
        batchSize: 100
      }),
      [
        { jobId: JOB_ID, state: "pending" },
        { jobId: secondJobId, state: "live" }
      ]
    );
    assert.equal(
      await admission.observeMissing(
        JOB_ID,
        PRINCIPAL_ID,
        10000
      ),
      "first_observation"
    );
    assert.equal(
      await admission.observeMissing(
        JOB_ID,
        PRINCIPAL_ID,
        10000
      ),
      "awaiting_confirmation"
    );
    assert.equal(
      await admission.observeMissing(
        JOB_ID,
        PRINCIPAL_ID,
        10000
      ),
      "released"
    );
    assert.equal(
      await admission.observeMissing(
        JOB_ID,
        PRINCIPAL_ID,
        10000
      ),
      "already_released"
    );
  });

  it("fails closed on malformed Redis decisions, ownership mismatches, and invalid IDs", async () => {
    for (const malformedResult of [
      ["unexpected"],
      [true, 0],
      [1],
      [1, 0, 0],
      [null, 0],
      ["1", 0]
    ]) {
      const malformed =
        createAdmission([malformedResult]).admission;
      await assert.rejects(
        malformed.consumeEnqueueRate(PRINCIPAL_ID),
        /Invalid Redis admission/
      );
    }

    const ownership = createAdmission([[-1], [-1]]).admission;
    assert.equal(
      await ownership.confirmQueued(JOB_ID, PRINCIPAL_ID),
      "wrong_owner"
    );
    await assert.rejects(
      ownership.releaseTerminal(
        JOB_ID,
        PRINCIPAL_ID,
        "bullmq-claim-token"
      ),
      /ownership mismatch/
    );

    const invalidId = createAdmission([]).admission;
    await assert.rejects(
      invalidId.reserve({
        jobId: "caller-selected",
        principalId: PRINCIPAL_ID
      }),
      /job ID/
    );
    assert.throws(
      () =>
        createRedisRuntimeAdmission({
          config: ADMISSION_CONFIG,
          getClient: async () => createFakeRedis([]).client,
          queueName: "bad}name"
        }),
      /queue name/
    );
  });
});
