import { Worker } from "bullmq";
import {
  resolveRuntimeAdmissionConfig
} from "./admission/config.js";
import {
  createRedisRuntimeAdmission
} from "./admission/redisAdmission.js";
import {
  AI_RUNTIME_PRINCIPAL_ID_ENV_NAME,
  readConfiguredAiRuntimePrincipalId
} from "./auth/runtimeHttpAuth.js";
import {
  assertRuntimeWorkerProviderConfiguration,
  resolveRuntimeShutdownConfig,
  resolveRuntimeWorkerStartupConfig
} from "./config/env.js";
import {
  resolveRuntimeRedisConnection
} from "./config/redisConnection.js";
import type { AIJobPayload } from "./jobs/types.js";
import { resolveRuntimeJobPolicy } from "./jobs/policy.js";
import {
  createRuntimeTerminalReleaseHandler,
  createRuntimeWorkerProcessor
} from "./jobs/workerProcessor.js";
import {
  createRuntimeShutdownCoordinator,
  createRuntimeWorkerShutdownHandlers,
  installRuntimeSignalHandlers
} from "./lifecycle/shutdown.js";
import {
  waitForRuntimeWorkerStartup
} from "./lifecycle/startup.js";
import {
  createAiQueueRuntime
} from "./queue/queue.js";

const workerPrincipalId = readConfiguredAiRuntimePrincipalId(
  process.env[AI_RUNTIME_PRINCIPAL_ID_ENV_NAME]
);
if (!workerPrincipalId) {
  throw new Error("AI runtime worker principal configuration is unavailable");
}
const workerJobPolicy = resolveRuntimeJobPolicy(process.env);
if (!workerJobPolicy) {
  throw new Error("AI runtime worker job policy is unavailable");
}
const admissionConfig = resolveRuntimeAdmissionConfig(process.env);
if (!admissionConfig) {
  throw new Error("AI runtime worker admission configuration is unavailable");
}
assertRuntimeWorkerProviderConfiguration(process.env);
const shutdownConfig = resolveRuntimeShutdownConfig(process.env);
const startupConfig =
  resolveRuntimeWorkerStartupConfig(process.env);
const queueRuntime = createAiQueueRuntime({
  environment: process.env
});
const workerConnection = resolveRuntimeRedisConnection(
  process.env,
  "worker"
);
const admission = createRedisRuntimeAdmission({
  config: admissionConfig,
  getClient: queueRuntime.getReadyClient,
  queueName: queueRuntime.name
});
const processRuntimeJob = createRuntimeWorkerProcessor({
  admission,
  expectedPrincipalId: workerPrincipalId,
  policy: workerJobPolicy
});
const releaseTerminalReservation =
  createRuntimeTerminalReleaseHandler(
    admission,
    workerPrincipalId
  );

const worker = new Worker<AIJobPayload>(
  queueRuntime.name,
  processRuntimeJob,
  {
    autorun: false,
    connection: workerConnection,
    concurrency: 3
  }
);

const pendingTerminalReleases = new Set<Promise<void>>();
function scheduleTerminalRelease(
  job: Parameters<typeof releaseTerminalReservation>[0]
): void {
  const release = releaseTerminalReservation(job).catch(() => {
    console.error("ai_runtime.admission.release_deferred");
  });
  pendingTerminalReleases.add(release);
  void release.then(() => {
    pendingTerminalReleases.delete(release);
  });
}

worker.on("error", () => {
  console.error("ai_runtime.worker.error");
});
worker.on("completed", (job) => {
  scheduleTerminalRelease(job);
});
worker.on("failed", (job) => {
  scheduleTerminalRelease(job);
});

const workerShutdown =
  createRuntimeWorkerShutdownHandlers({
    worker,
    async waitForTerminalReleases() {
      await Promise.all([...pendingTerminalReleases]);
    },
    closeQueue: queueRuntime.close
  });
const shutdownCoordinator =
  createRuntimeShutdownCoordinator({
    timeoutMs: shutdownConfig.timeoutMs,
    force: workerShutdown.force,
    graceful: workerShutdown.graceful
  });
installRuntimeSignalHandlers(shutdownCoordinator);

void waitForRuntimeWorkerStartup({
  readiness: [
    queueRuntime.waitUntilReady(),
    worker.waitUntilReady()
  ],
  timeoutMs: startupConfig.timeoutMs
})
  .then(async () => {
    if (shutdownCoordinator.isShuttingDown()) {
      return;
    }
    console.log("ai_runtime.worker.ready");
    await worker.run();
  })
  .catch(() => {
    if (!shutdownCoordinator.isShuttingDown()) {
      console.error("ai_runtime.worker.start_failed");
      void shutdownCoordinator.shutdown("SIGTERM").then(
        () => process.exit(1),
        () => process.exit(1)
      );
    }
  });
