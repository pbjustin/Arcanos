import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import {
  resolveRuntimeRedisConnection
} from "../dist/config/redisConnection.js";
import {
  AI_RUNTIME_QUEUE_NAME_ENV_NAME,
  resolveRuntimeQueueName
} from "../dist/config/queueName.js";
import {
  assertRuntimeWorkerProviderConfiguration,
  resolveRuntimeHttpConfig,
  resolveRuntimeQueueRetentionConfig
} from "../dist/config/env.js";
import {
  createAiQueueRuntime,
  createRuntimeQueueGate
} from "../dist/queue/queue.js";

class FakeRedisClient extends EventEmitter {
  status = "connecting";
}

class FakeQueue extends EventEmitter {
  constructor(clientPromise, name = "ai-jobs") {
    super();
    this.client = clientPromise;
    this.name = name;
    this.addCalls = 0;
    this.getJobCalls = 0;
    this.closed = false;
  }

  async add() {
    this.addCalls += 1;
    return { id: "queued" };
  }

  async getJob() {
    this.getJobCalls += 1;
    return undefined;
  }

  async close() {
    this.closed = true;
  }
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("standalone AI runtime Redis transport", () => {
  it("bounds producer connection and command failure behavior", () => {
    const options = resolveRuntimeRedisConnection(
      {
        REDIS_HOST: "redis.internal",
        REDIS_PORT: "6380"
      },
      "producer"
    );

    assert.equal(options.host, "redis.internal");
    assert.equal(options.port, 6380);
    assert.equal(options.connectTimeout, 3000);
    assert.equal(options.commandTimeout, 2000);
    assert.equal(options.autoResendUnfulfilledCommands, false);
    assert.equal(options.enableOfflineQueue, false);
    assert.equal(options.enableReadyCheck, true);
    assert.equal(options.lazyConnect, false);
    assert.equal(options.maxRetriesPerRequest, 1);
    assert.equal(options.connectionName, "arcanos-ai-runtime-producer");
    assert.equal(typeof options.retryStrategy, "function");
    assert.equal(options.retryStrategy(1), 250);
    assert.equal(options.retryStrategy(3), 1000);
    assert.equal(options.retryStrategy(100), 5000);
  });

  it("supports an ACL and TLS URL with a worker-safe profile", () => {
    const url =
      "REDISS://runtime-user:test-only@redis.invalid:6380/4";
    const options = resolveRuntimeRedisConnection(
      {
        AI_RUNTIME_REDIS_URL: url,
        REDIS_HOST: "ignored.invalid",
        REDIS_PORT: "not-a-port"
      },
      "worker"
    );

    assert.equal(
      options.url,
      "rediss://runtime-user:test-only@redis.invalid:6380/4"
    );
    assert.equal(options.connectTimeout, 3000);
    assert.equal(options.commandTimeout, undefined);
    assert.equal(options.autoResendUnfulfilledCommands, true);
    assert.equal(options.enableOfflineQueue, true);
    assert.equal(options.enableReadyCheck, true);
    assert.equal(options.lazyConnect, false);
    assert.equal(options.maxRetriesPerRequest, null);
    assert.equal(options.connectionName, "arcanos-ai-runtime-worker");
    assert.equal(typeof options.retryStrategy, "function");
    assert.equal(options.retryStrategy(1), 250);
    assert.equal(options.retryStrategy(100), 5000);
  });

  it("fails closed on malformed or ambiguous Redis targets", () => {
    assert.throws(
      () => resolveRuntimeRedisConnection({}, "producer"),
      /configuration is unavailable/
    );
    assert.throws(
      () =>
        resolveRuntimeRedisConnection(
          { REDIS_HOST: "redis.internal", REDIS_PORT: "0" },
          "producer"
        ),
      /Invalid standalone AI runtime Redis port/
    );

    const invalidUrls = [
      "http://runtime-user:do-not-log@redis.invalid:6380/4",
      " rediss://redis.invalid:6380/4",
      "rediss://redis.invalid:6380/%0a",
      "rediss://redis.invalid:6380/not-a-database",
      "rediss://redis.invalid:6380/4?rejectUnauthorized=false",
      "rediss://redis.invalid:6380/4#fragment"
    ];
    invalidUrls.push(
      `rediss://${"a".repeat(4096)}.invalid/4`
    );
    for (const url of invalidUrls) {
      assert.throws(
        () =>
          resolveRuntimeRedisConnection(
            { AI_RUNTIME_REDIS_URL: url },
            "producer"
          ),
        (error) => {
          assert.equal(
            error.message,
            "Invalid standalone AI runtime Redis URL"
          );
          assert.equal(error.message.includes(url), false);
          return true;
        }
      );
    }
  });

  it("rejects unknown connection profiles", () => {
    assert.throws(
      () =>
        resolveRuntimeRedisConnection(
          { REDIS_HOST: "redis.internal" },
          "unknown"
        ),
      /Invalid standalone AI runtime Redis connection profile/
    );
  });

  it("requires an explicit deployment-scoped Queue name", async () => {
    assert.throws(
      () => resolveRuntimeQueueName({}),
      /queue name configuration is unavailable/
    );
    for (const queueName of [
      " ai-runtime-v2",
      "AI-runtime-v2",
      "ai:runtime:v2",
      `${"a".repeat(65)}`
    ]) {
      assert.throws(
        () =>
          resolveRuntimeQueueName({
            [AI_RUNTIME_QUEUE_NAME_ENV_NAME]: queueName
          }),
        /queue name configuration is unavailable/
      );
    }

    const configuredQueueName = "arcanos-prod-ai-v2";
    const client = new FakeRedisClient();
    client.status = "ready";
    let capturedOptions;
    const runtime = createAiQueueRuntime({
      environment: {
        [AI_RUNTIME_QUEUE_NAME_ENV_NAME]:
          configuredQueueName,
        REDIS_HOST: "redis.internal"
      },
      createQueue(name, options) {
        assert.equal(name, configuredQueueName);
        capturedOptions = options;
        return new FakeQueue(
          Promise.resolve(client),
          name
        );
      }
    });
    await runtime.waitUntilReady();
    assert.equal(runtime.name, configuredQueueName);
    assert.equal(
      capturedOptions.connection.connectionName,
      "arcanos-ai-runtime-producer"
    );
    assert.equal(
      capturedOptions.defaultJobOptions.attempts,
      1
    );
    await runtime.close();
  });

  it("keeps provider secrets out of the HTTP configuration", () => {
    assert.deepEqual(
      resolveRuntimeHttpConfig({}),
      { port: 3000 }
    );
    assert.deepEqual(
      resolveRuntimeQueueRetentionConfig({}),
      {
        jobRetentionSeconds: 3600,
        maxCompletedJobs: 1000,
        maxFailedJobs: 1000
      }
    );
    assert.throws(
      () => assertRuntimeWorkerProviderConfiguration({}),
      /Missing required environment variable: OPENAI_API_KEY/
    );
    assert.doesNotThrow(() =>
      assertRuntimeWorkerProviderConfiguration({
        OPENAI_API_KEY: "test-only-provider-key"
      })
    );
  });

  it("gates Queue calls until Redis is ready and recovers", async () => {
    const deferred = createDeferred();
    const rawQueue = new FakeQueue(deferred.promise);
    const events = [];
    const runtime = createRuntimeQueueGate(rawQueue, {
      error(event) {
        events.push(event);
      }
    });

    assert.equal(rawQueue.listenerCount("error"), 1);
    assert.equal(rawQueue.listenerCount("ioredis:close"), 1);
    await assert.rejects(
      runtime.queue.add("ai-job", {}, { jobId: "job-id" }),
      /Redis queue is unavailable/
    );
    await assert.rejects(
      runtime.queue.getJob("job-id"),
      /Redis queue is unavailable/
    );
    assert.equal(rawQueue.addCalls, 0);
    assert.equal(rawQueue.getJobCalls, 0);
    assert.deepEqual(events, [
      "ai_runtime.queue.redis_unavailable"
    ]);

    assert.doesNotThrow(() => {
      rawQueue.emit(
        "error",
        new Error(
          "rediss://runtime-user:sensitive@redis.invalid"
        )
      );
    });
    assert.deepEqual(events, [
      "ai_runtime.queue.redis_unavailable"
    ]);

    const client = new FakeRedisClient();
    client.status = "ready";
    deferred.resolve(client);
    await runtime.waitUntilReady();
    assert.equal(runtime.isReady(), true);
    await runtime.queue.add("ai-job", {}, { jobId: "job-id" });
    await runtime.queue.getJob("job-id");
    assert.equal(rawQueue.addCalls, 1);
    assert.equal(rawQueue.getJobCalls, 1);

    client.status = "reconnecting";
    client.emit("close");
    await assert.rejects(
      runtime.queue.getJob("job-id"),
      /Redis queue is unavailable/
    );
    assert.deepEqual(events, [
      "ai_runtime.queue.redis_unavailable",
      "ai_runtime.queue.redis_unavailable"
    ]);
    client.status = "ready";
    client.emit("ready");
    assert.equal(runtime.isReady(), true);

    await runtime.close();
    assert.equal(rawQueue.closed, true);
    assert.equal(runtime.isReady(), false);
  });

  it("handles rejected Queue initialization without raw logs", async () => {
    const deferred = createDeferred();
    const rawQueue = new FakeQueue(deferred.promise);
    const events = [];
    const runtime = createRuntimeQueueGate(rawQueue, {
      error(event) {
        events.push(event);
      }
    });
    deferred.reject(
      new Error(
        "rediss://runtime-user:sensitive@redis.invalid"
      )
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [
      "ai_runtime.queue.redis_unavailable"
    ]);
    await assert.rejects(
      runtime.getReadyClient(),
      /Redis queue is unavailable/
    );
    await runtime.close();
  });

  it("does not become ready after closure wins initialization", async () => {
    const deferred = createDeferred();
    const rawQueue = new FakeQueue(deferred.promise);
    const runtime = createRuntimeQueueGate(rawQueue);
    const readiness = assert.rejects(
      runtime.waitUntilReady(),
      /Redis queue is unavailable/
    );

    await runtime.close();
    const client = new FakeRedisClient();
    client.status = "ready";
    deferred.resolve(client);

    await readiness;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runtime.isReady(), false);
    assert.equal(client.listenerCount("ready"), 0);
    assert.equal(client.listenerCount("close"), 0);
    assert.equal(client.listenerCount("end"), 0);
  });

  it("imports Queue configuration without environment or sockets", () => {
    const childEnvironment = { ...process.env };
    for (const name of [
      "AI_RUNTIME_QUEUE_NAME",
      "AI_RUNTIME_REDIS_URL",
      "REDIS_HOST",
      "REDIS_PORT",
      "OPENAI_API_KEY"
    ]) {
      delete childEnvironment[name];
    }
    const queueModuleUrl = new URL(
      "../dist/queue/queue.js",
      import.meta.url
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `await import(${JSON.stringify(queueModuleUrl)});`
      ],
      {
        encoding: "utf8",
        env: childEnvironment,
        timeout: 3000
      }
    );

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.signal, null);
  });
});
