import {
  Queue,
  type JobsOptions,
  type QueueOptions,
  type RedisClient
} from "bullmq";

import {
  resolveRuntimeQueueRetentionConfig
} from "../config/env.js";
import {
  resolveRuntimeQueueName
} from "../config/queueName.js";
import {
  resolveRuntimeRedisConnection
} from "../config/redisConnection.js";
import type { AIJobPayload } from "../jobs/types.js";
import type { RuntimeQueuePort } from "./types.js";

export interface RuntimeQueueLogger {
  error(event: string): void;
}

interface RuntimeOwnedQueue extends RuntimeQueuePort {
  readonly client: Promise<RedisClient>;
  readonly name: string;
  close(): Promise<void>;
  on(
    event: "error",
    listener: (error: Error) => void
  ): unknown;
  on(
    event: "ioredis:close",
    listener: () => void
  ): unknown;
}

export interface CreateAiQueueRuntimeOptions {
  environment: NodeJS.ProcessEnv;
  logger?: RuntimeQueueLogger;
  createQueue?: (
    name: string,
    options: QueueOptions
  ) => RuntimeOwnedQueue;
}

export interface AiQueueRuntime {
  readonly name: string;
  readonly queue: RuntimeQueuePort;
  close(): Promise<void>;
  getReadyClient(): Promise<RedisClient>;
  isReady(): boolean;
  waitUntilReady(): Promise<void>;
}

function createBullMqQueue(
  name: string,
  options: QueueOptions
): RuntimeOwnedQueue {
  return new Queue<AIJobPayload>(name, options);
}

export function createRuntimeQueueGate(
  rawQueue: RuntimeOwnedQueue,
  logger: RuntimeQueueLogger = console
): AiQueueRuntime {
  let readyClient: RedisClient | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let outageLogged = false;

  function markReady(): void {
    outageLogged = false;
  }

  function markUnavailable(): void {
    if (closing || outageLogged) {
      return;
    }
    outageLogged = true;
    logger.error("ai_runtime.queue.redis_unavailable");
  }

  rawQueue.on("error", () => {
    markUnavailable();
  });
  rawQueue.on("ioredis:close", () => {
    markUnavailable();
  });
  void rawQueue.client
    .then((client) => {
      if (closing) {
        return;
      }
      readyClient = client;
      client.on("ready", markReady);
      client.on("close", markUnavailable);
      client.on("end", markUnavailable);
      if (client.status === "ready") {
        markReady();
      } else {
        markUnavailable();
      }
    })
    .catch(() => {
      markUnavailable();
    });

  async function getReadyClient(): Promise<RedisClient> {
    if (
      closing ||
      !readyClient ||
      readyClient.status !== "ready"
    ) {
      markUnavailable();
      throw new Error("AI runtime Redis queue is unavailable");
    }
    return readyClient;
  }

  const queue: RuntimeQueuePort = {
    async add(name, data, options) {
      await getReadyClient();
      return rawQueue.add(name, data, options);
    },
    async getJob(jobId) {
      await getReadyClient();
      return rawQueue.getJob(jobId);
    }
  };

  return {
    name: rawQueue.name,
    queue,
    close() {
      closing = true;
      readyClient = undefined;
      closePromise ??= rawQueue.close();
      return closePromise;
    },
    getReadyClient,
    isReady() {
      return (
        !closing &&
        readyClient?.status === "ready"
      );
    },
    async waitUntilReady() {
      if (closing) {
        throw new Error(
          "AI runtime Redis queue is unavailable"
        );
      }
      const client = await rawQueue.client;
      if (closing) {
        throw new Error(
          "AI runtime Redis queue is unavailable"
        );
      }
      readyClient = client;
      if (client.status !== "ready") {
        throw new Error("AI runtime Redis queue is unavailable");
      }
      markReady();
    }
  };
}

export function createAiQueueRuntime(
  options: CreateAiQueueRuntimeOptions
): AiQueueRuntime {
  const retention = resolveRuntimeQueueRetentionConfig(
    options.environment
  );
  const connection = resolveRuntimeRedisConnection(
    options.environment,
    "producer"
  );
  const queueName = resolveRuntimeQueueName(
    options.environment
  );
  const defaultJobOptions: JobsOptions = {
    attempts: 1,
    removeOnComplete: {
      age: retention.jobRetentionSeconds,
      count: retention.maxCompletedJobs
    },
    removeOnFail: {
      age: retention.jobRetentionSeconds,
      count: retention.maxFailedJobs
    }
  };
  const createQueue = options.createQueue ?? createBullMqQueue;
  const rawQueue = createQueue(queueName, {
    connection,
    defaultJobOptions
  });
  return createRuntimeQueueGate(
    rawQueue,
    options.logger
  );
}
