import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  after,
  before,
  describe,
  it
} from "node:test";

import {
  Queue,
  Worker
} from "bullmq";
import { Redis } from "ioredis";

import {
  createRedisRuntimeAdmission
} from "../dist/admission/redisAdmission.js";
import {
  createRuntimeTerminalReleaseHandler,
  createRuntimeWorkerProcessor
} from "../dist/jobs/workerProcessor.js";

const TEST_REDIS_URL_ENV_NAME =
  "AI_RUNTIME_TEST_REDIS_URL";
const TEST_REDIS_CONFIRMATION_ENV_NAME =
  "AI_RUNTIME_TEST_REDIS_CONFIRM_DISPOSABLE";
const TEST_REDIS_CONFIRMATION =
  "disposable-loopback-only";
const TEST_DATABASE_PATH = "/15";
const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "[::1]"
]);
const PRINCIPAL_ID = "operator:runtime-redis-integration";
const OTHER_PRINCIPAL_ID = "operator:runtime-redis-other";
const JOB_POLICY = Object.freeze({
  allowedModels: Object.freeze(["gpt-5"]),
  defaultMaxTokens: 128,
  maxTokens: 512
});

const BASE_CONFIG = Object.freeze({
  maxOutstanding: 5,
  rateMax: 4,
  rateWindowMs: 60000,
  pendingGraceMs: 30000,
  missingConfirmMs: 10000,
  reconcileIntervalMs: 5000,
  reconcileBatchSize: 100,
  claimGraceMs: 180000
});

function resolveDisposableLoopbackRedisUrl(environment) {
  if (
    environment[TEST_REDIS_CONFIRMATION_ENV_NAME] !==
    TEST_REDIS_CONFIRMATION
  ) {
    throw new Error(
      "Disposable loopback Redis confirmation is required"
    );
  }

  const rawUrl = environment[TEST_REDIS_URL_ENV_NAME];
  if (
    typeof rawUrl !== "string" ||
    rawUrl !== rawUrl.trim() ||
    rawUrl.length === 0
  ) {
    throw new Error(
      "Disposable loopback Redis URL is required"
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    throw new Error(
      "Disposable loopback Redis URL failed validation"
    );
  }

  if (
    parsedUrl.protocol !== "redis:" ||
    !LOOPBACK_HOSTS.has(parsedUrl.hostname) ||
    parsedUrl.port.length === 0 ||
    parsedUrl.pathname !== TEST_DATABASE_PATH ||
    parsedUrl.search.length > 0 ||
    parsedUrl.hash.length > 0
  ) {
    throw new Error(
      "Disposable Redis tests require explicit loopback database 15"
    );
  }

  return rawUrl;
}

function createQueueName() {
  return `ai-ci-${randomUUID().slice(0, 12)}`;
}

function createJobId() {
  return randomUUID();
}

function getAdmissionKeys(queueName) {
  const prefix =
    `arcanos:ai-runtime:admission:{${queueName}}`;
  return {
    allPattern: `${prefix}:*`,
    live: `${prefix}:live`,
    missing: `${prefix}:missing`,
    pending: `${prefix}:pending`,
    ratePattern: `${prefix}:rate:*`,
    reservations: `${prefix}:reservations`
  };
}

const redisUrl = resolveDisposableLoopbackRedisUrl(
  process.env
);
const queueNames = new Set();
const redisClients = [];

function createAdmission(
  configOverrides = {},
  queueName,
  redisClient = redisClients[0]
) {
  const resolvedQueueName = queueName ?? createQueueName();
  queueNames.add(resolvedQueueName);
  return createRedisRuntimeAdmission({
    config: Object.freeze({
      ...BASE_CONFIG,
      ...configOverrides
    }),
    generateAttemptId: randomUUID,
    getClient: async () => redisClient,
    queueName: resolvedQueueName
  });
}

async function deleteAdmissionKeys(queueName) {
  await deleteKeysMatching(getAdmissionKeys(queueName).allPattern);
}

async function scanKeys(pattern) {
  const discoveredKeys = new Set();
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redisClients[0].scan(
      cursor,
      "MATCH",
      pattern,
      "COUNT",
      100
    );
    cursor = nextCursor;
    for (const key of keys) {
      discoveredKeys.add(key);
    }
  } while (cursor !== "0");
  return [...discoveredKeys];
}

async function deleteKeysMatching(pattern) {
  const keys = await scanKeys(pattern);
  if (keys.length > 0) {
    await redisClients[0].del(...keys);
  }
}

async function getRedisTimeMs() {
  const [seconds, microseconds] =
    await redisClients[0].time();
  return (
    Number(seconds) * 1000 +
    Math.floor(Number(microseconds) / 1000)
  );
}

function createWorkerTerminalWaiter(
  worker,
  releaseTerminal,
  expectedJobId
) {
  let cleanup = () => {};
  const promise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for BullMQ terminal event"));
    }, 10000);

    const settle = (state, job) => {
      if (String(job?.id ?? "") !== expectedJobId) {
        return;
      }
      cleanup();
      void releaseTerminal(job).then(
        () => resolve({ state, job }),
        reject
      );
    };
    const onCompleted = (job) => {
      settle("completed", job);
    };
    const onFailed = (job) => {
      settle("failed", job);
    };
    cleanup = () => {
      clearTimeout(timeout);
      worker.off("completed", onCompleted);
      worker.off("failed", onFailed);
    };

    worker.on("completed", onCompleted);
    worker.on("failed", onFailed);
  });
  return { cancel: cleanup, promise };
}

async function enqueueAndWaitForWorkerTerminal(
  queue,
  worker,
  releaseTerminal,
  jobId,
  payload
) {
  const terminal = createWorkerTerminalWaiter(
    worker,
    releaseTerminal,
    jobId
  );
  try {
    await queue.add("ai-job", payload, { jobId });
  } catch (error) {
    terminal.cancel();
    throw error;
  }
  return terminal.promise;
}

function createTestRedisClient(connectionName) {
  const client = new Redis(redisUrl, {
    commandTimeout: 2000,
    connectionName,
    connectTimeout: 2000,
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: null
  });
  client.on("error", () => {});
  return client;
}

async function closeRedisClient(client) {
  if (!client || client.status === "end") {
    return;
  }
  if (client.status === "ready") {
    try {
      await client.quit();
    } finally {
      if (client.status !== "end") {
        client.disconnect();
      }
    }
    return;
  }
  client.disconnect();
}

async function closeBullMqResource(resource) {
  if (!resource) {
    return;
  }
  try {
    await resource.close();
  } catch (error) {
    try {
      await resource.disconnect();
    } catch {
      // Preserve the original close failure for the test result.
    }
    throw error;
  }
}

before(async () => {
  redisClients.push(
    createTestRedisClient("arcanos-runtime-ci-replica-a"),
    createTestRedisClient("arcanos-runtime-ci-replica-b")
  );
  await Promise.all(
    redisClients.map(async (client) => {
      await client.connect();
      assert.equal(await client.ping(), "PONG");
    })
  );
});

after(async () => {
  try {
    if (redisClients[0]?.status === "ready") {
      for (const queueName of queueNames) {
        await deleteAdmissionKeys(queueName);
      }
    }
  } finally {
    await Promise.allSettled(
      redisClients.map(closeRedisClient)
    );
  }
});

describe("standalone runtime admission against disposable Redis", () => {
  it("executes every admission Lua lifecycle with ownership fencing", async () => {
    const queueName = createQueueName();
    const admission = createAdmission({}, queueName);
    const keys = getAdmissionKeys(queueName);
    const firstJobId = createJobId();
    const firstClaimId = "bullmq-integration-claim";

    assert.deepEqual(
      await admission.consumeEnqueueRate(PRINCIPAL_ID),
      { kind: "allowed" }
    );
    assert.deepEqual(
      await admission.reserve({
        jobId: firstJobId,
        principalId: PRINCIPAL_ID
      }),
      { kind: "granted" }
    );
    assert.equal(
      await admission.confirmQueued(
        firstJobId,
        OTHER_PRINCIPAL_ID
      ),
      "wrong_owner"
    );
    assert.equal(
      await redisClients[0].hlen(keys.reservations),
      1
    );
    assert.equal(await redisClients[0].zcard(keys.pending), 1);
    assert.equal(await redisClients[0].zcard(keys.live), 0);
    assert.equal(
      await admission.confirmQueued(
        firstJobId,
        PRINCIPAL_ID
      ),
      "confirmed"
    );
    assert.equal(
      await admission.claimForExecution(
        firstJobId,
        PRINCIPAL_ID,
        firstClaimId
      ),
      "claimed"
    );
    assert.equal(
      await admission.claimForExecution(
        firstJobId,
        PRINCIPAL_ID,
        firstClaimId
      ),
      "already_claimed"
    );
    await assert.rejects(
      admission.releaseTerminal(
        firstJobId,
        PRINCIPAL_ID,
        "different-bullmq-claim"
      ),
      /ownership mismatch/
    );
    assert.equal(
      await redisClients[0].hlen(keys.reservations),
      1
    );
    assert.equal(await redisClients[0].zcard(keys.live), 1);
    await admission.releaseTerminal(
      firstJobId,
      PRINCIPAL_ID,
      firstClaimId
    );
    assert.equal(
      await admission.confirmQueued(
        firstJobId,
        PRINCIPAL_ID
      ),
      "already_released"
    );

    const missingJobId = createJobId();
    assert.deepEqual(
      await admission.reserve({
        jobId: missingJobId,
        principalId: PRINCIPAL_ID
      }),
      { kind: "granted" }
    );
    const missingConfirmationMs = 60000;
    await redisClients[0].zadd(
      keys.pending,
      (await getRedisTimeMs()) - missingConfirmationMs - 1,
      missingJobId
    );
    const candidates =
      await admission.listReconciliationCandidates({
        pendingGraceMs: missingConfirmationMs,
        liveGraceMs: missingConfirmationMs,
        batchSize: 100
      });
    assert.equal(
      candidates.some(
        ({ jobId, state }) =>
          jobId === missingJobId && state === "pending"
      ),
      true
    );
    assert.equal(
      await admission.observeMissing(
        missingJobId,
        PRINCIPAL_ID,
        missingConfirmationMs
      ),
      "first_observation"
    );
    assert.equal(
      await admission.observeMissing(
        missingJobId,
        PRINCIPAL_ID,
        missingConfirmationMs
      ),
      "awaiting_confirmation"
    );
    await redisClients[0].zadd(
      keys.missing,
      (await getRedisTimeMs()) - missingConfirmationMs - 1,
      missingJobId
    );
    assert.equal(
      await admission.observeMissing(
        missingJobId,
        PRINCIPAL_ID,
        missingConfirmationMs
      ),
      "released"
    );

    const reconciledJobId = createJobId();
    assert.deepEqual(
      await admission.reserve({
        jobId: reconciledJobId,
        principalId: PRINCIPAL_ID
      }),
      { kind: "granted" }
    );
    assert.equal(
      await admission.confirmQueued(
        reconciledJobId,
        PRINCIPAL_ID
      ),
      "confirmed"
    );
    await admission.releaseReconciled(
      reconciledJobId,
      PRINCIPAL_ID
    );
    assert.equal(
      await admission.confirmQueued(
        reconciledJobId,
        PRINCIPAL_ID
      ),
      "already_released"
    );
    assert.equal(
      await redisClients[0].hlen(keys.reservations),
      0
    );
    assert.equal(await redisClients[0].zcard(keys.pending), 0);
    assert.equal(await redisClients[0].zcard(keys.live), 0);
    assert.equal(await redisClients[0].zcard(keys.missing), 0);
    const admissionKeys = await scanKeys(keys.allPattern);
    assert.equal(
      admissionKeys.some(
        (key) =>
          key.includes(PRINCIPAL_ID) ||
          key.includes(OTHER_PRINCIPAL_ID)
      ),
      false
    );
  });

  it("enforces one global outstanding cap across adapter instances", async () => {
    const queueName = createQueueName();
    const keys = getAdmissionKeys(queueName);
    const firstReplica = createAdmission(
      { maxOutstanding: 5 },
      queueName,
      redisClients[0]
    );
    const secondReplica = createAdmission(
      { maxOutstanding: 5 },
      queueName,
      redisClients[1]
    );

    const decisions = await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        (index % 2 === 0
          ? firstReplica
          : secondReplica
        ).reserve({
          jobId: createJobId(),
          principalId: PRINCIPAL_ID
        })
      )
    );

    assert.equal(
      decisions.filter(({ kind }) => kind === "granted").length,
      5
    );
    assert.equal(
      decisions.filter(({ kind }) => kind === "saturated").length,
      20
    );
    assert.equal(
      await redisClients[0].hlen(keys.reservations),
      5
    );
    assert.equal(await redisClients[0].zcard(keys.pending), 5);
    assert.equal(await redisClients[0].zcard(keys.live), 0);
    assert.equal(await redisClients[0].zcard(keys.missing), 0);
  });

  it("enforces one Redis-time rate window across adapter instances", async () => {
    const queueName = createQueueName();
    const keys = getAdmissionKeys(queueName);
    const firstReplica = createAdmission(
      { rateMax: 4 },
      queueName,
      redisClients[0]
    );
    const secondReplica = createAdmission(
      { rateMax: 4 },
      queueName,
      redisClients[1]
    );

    const decisions = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        (index % 2 === 0
          ? firstReplica
          : secondReplica
        ).consumeEnqueueRate(PRINCIPAL_ID)
      )
    );

    assert.equal(
      decisions.filter(({ kind }) => kind === "allowed").length,
      4
    );
    assert.equal(
      decisions.filter(
        ({ kind }) => kind === "rate_limited"
      ).length,
      16
    );
    const rateKeys = await scanKeys(keys.ratePattern);
    assert.equal(rateKeys.length, 1);
    assert.equal(
      rateKeys[0].includes(PRINCIPAL_ID),
      false
    );
    assert.equal(await redisClients[0].zcard(rateKeys[0]), 4);
    const rateTtlMs = await redisClients[0].pttl(rateKeys[0]);
    assert.equal(rateTtlMs > 0, true);
    assert.equal(rateTtlMs <= BASE_CONFIG.rateWindowMs, true);
  });

  it(
    "fences real BullMQ execution and releases terminal reservations",
    { timeout: 20000 },
    async () => {
      const queueName = createQueueName();
      queueNames.add(queueName);
      let queueClient;
      let workerClient;
      let queue;
      let worker;
      let workerRunPromise;
      let testFailure;

      try {
        queueClient = createTestRedisClient(
          "arcanos-runtime-ci-bullmq-queue"
        );
        workerClient = new Redis(redisUrl, {
          connectionName: "arcanos-runtime-ci-bullmq-worker",
          connectTimeout: 2000,
          enableOfflineQueue: true,
          lazyConnect: true,
          maxRetriesPerRequest: null,
          retryStrategy: null
        });
        queueClient.on("error", () => {});
        workerClient.on("error", () => {});
        await Promise.all([
          queueClient.connect(),
          workerClient.connect()
        ]);

        queue = new Queue(queueName, {
          connection: queueClient,
          defaultJobOptions: {
            attempts: 1,
            removeOnComplete: false,
            removeOnFail: false
          }
        });
        queue.on("error", () => {});
        const admission = createAdmission(
          {},
          queueName,
          redisClients[0]
        );
        const admissionKeys = getAdmissionKeys(queueName);
        let executeCalls = 0;
        const processor = createRuntimeWorkerProcessor({
          admission,
          expectedPrincipalId: PRINCIPAL_ID,
          policy: JOB_POLICY,
          async execute(job) {
            executeCalls += 1;
            if (
              job.messages[0]?.content ===
              "make-provider-fail"
            ) {
              throw new Error("test provider failure");
            }
            return { output_text: "completed safely" };
          }
        });
        const terminalEvents = [];
        const releaseTerminal =
          createRuntimeTerminalReleaseHandler(
            admission,
            PRINCIPAL_ID,
            {
              error(event) {
                terminalEvents.push(event);
              }
            }
          );
        worker = new Worker(queueName, processor, {
          autorun: false,
          connection: workerClient,
          concurrency: 1
        });
        worker.on("error", () => {});

        const buildPayload = (content) => ({
          principalId: PRINCIPAL_ID,
          model: "gpt-5",
          messages: [{ role: "user", content }],
          maxTokens: 128
        });

        await Promise.all([
          queue.waitUntilReady(),
          worker.waitUntilReady()
        ]);
        workerRunPromise = worker.run();
        void workerRunPromise.catch(() => {});

        const unreservedJobId = createJobId();
        const unreservedTerminal =
          await enqueueAndWaitForWorkerTerminal(
            queue,
            worker,
            releaseTerminal,
            unreservedJobId,
            buildPayload("must-not-execute")
          );
        assert.equal(
          unreservedTerminal.state,
          "failed"
        );
        assert.equal(executeCalls, 0);

        const completedJobId = createJobId();
        assert.deepEqual(
          await admission.reserve({
            jobId: completedJobId,
            principalId: PRINCIPAL_ID
          }),
          { kind: "granted" }
        );
        assert.equal(
          await admission.confirmQueued(
            completedJobId,
            PRINCIPAL_ID
          ),
          "confirmed"
        );
        const completedTerminal =
          await enqueueAndWaitForWorkerTerminal(
            queue,
            worker,
            releaseTerminal,
            completedJobId,
            buildPayload("complete-provider-call")
          );
        assert.equal(
          completedTerminal.state,
          "completed"
        );
        assert.equal(executeCalls, 1);
        assert.equal(
          await admission.confirmQueued(
            completedJobId,
            PRINCIPAL_ID
          ),
          "already_released"
        );

        const failedJobId = createJobId();
        assert.deepEqual(
          await admission.reserve({
            jobId: failedJobId,
            principalId: PRINCIPAL_ID
          }),
          { kind: "granted" }
        );
        assert.equal(
          await admission.confirmQueued(
            failedJobId,
            PRINCIPAL_ID
          ),
          "confirmed"
        );
        const failedTerminal =
          await enqueueAndWaitForWorkerTerminal(
            queue,
            worker,
            releaseTerminal,
            failedJobId,
            buildPayload("make-provider-fail")
          );
        assert.equal(
          failedTerminal.state,
          "failed"
        );
        assert.equal(executeCalls, 2);
        assert.equal(
          await admission.confirmQueued(
            failedJobId,
            PRINCIPAL_ID
          ),
          "already_released"
        );
        assert.deepEqual(terminalEvents, []);
        assert.equal(
          await redisClients[0].hlen(
            admissionKeys.reservations
          ),
          0
        );
        assert.equal(
          await redisClients[0].zcard(admissionKeys.pending),
          0
        );
        assert.equal(
          await redisClients[0].zcard(admissionKeys.live),
          0
        );
        assert.equal(
          await redisClients[0].zcard(admissionKeys.missing),
          0
        );
      } catch (error) {
        testFailure = error;
        throw error;
      } finally {
        const resourceCleanup = await Promise.allSettled([
          closeBullMqResource(worker),
          closeBullMqResource(queue)
        ]);
        const workerRunCleanup = workerRunPromise
          ? await Promise.allSettled([workerRunPromise])
          : [];
        const clientCleanup = await Promise.allSettled([
          closeRedisClient(workerClient),
          closeRedisClient(queueClient)
        ]);
        const keyCleanup =
          redisClients[0]?.status === "ready"
            ? await Promise.allSettled([
                deleteKeysMatching(`bull:${queueName}:*`)
              ])
            : [];
        if (!testFailure) {
          const cleanupFailure = [
            ...resourceCleanup,
            ...workerRunCleanup,
            ...clientCleanup,
            ...keyCleanup
          ].find(({ status }) => status === "rejected");
          if (cleanupFailure?.status === "rejected") {
            throw cleanupFailure.reason;
          }
        }
      }
    }
  );
});
