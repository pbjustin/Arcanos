import {
  resolveRuntimeAdmissionConfig
} from "./admission/config.js";
import {
  createRedisRuntimeAdmission
} from "./admission/redisAdmission.js";
import {
  createRuntimeAdmissionReconciler
} from "./admission/reconciler.js";
import {
  AI_RUNTIME_PRINCIPAL_ID_ENV_NAME,
  readConfiguredAiRuntimePrincipalId
} from "./auth/runtimeHttpAuth.js";
import {
  resolveRuntimeHttpConfig,
  resolveRuntimeShutdownConfig
} from "./config/env.js";
import {
  createRuntimeShutdownCoordinator,
  installRuntimeSignalHandlers
} from "./lifecycle/shutdown.js";
import {
  createAiQueueRuntime
} from "./queue/queue.js";
import { createRuntimeApp } from "./app.js";

const admissionConfig = resolveRuntimeAdmissionConfig(process.env);
if (!admissionConfig) {
  throw new Error("AI runtime admission configuration is unavailable");
}

const principalId = readConfiguredAiRuntimePrincipalId(
  process.env[AI_RUNTIME_PRINCIPAL_ID_ENV_NAME]
);
if (!principalId) {
  throw new Error("AI runtime principal configuration is unavailable");
}
const runtimeHttpConfig = resolveRuntimeHttpConfig(process.env);
const shutdownConfig = resolveRuntimeShutdownConfig(process.env);
const queueRuntime = createAiQueueRuntime({
  environment: process.env
});
const admission = createRedisRuntimeAdmission({
  config: admissionConfig,
  getClient: queueRuntime.getReadyClient,
  queueName: queueRuntime.name
});
const admissionReconciler = createRuntimeAdmissionReconciler({
  admission,
  config: admissionConfig,
  expectedPrincipalId: principalId,
  queue: queueRuntime.queue
});
const app = createRuntimeApp({
  queue: queueRuntime.queue,
  admission,
  readiness: queueRuntime
});
const httpServer = app.listen(runtimeHttpConfig.port, () => {
  if (!shutdownCoordinator.isShuttingDown()) {
    admissionReconciler.start();
  }
  console.log(`API running on port ${runtimeHttpConfig.port}`);
});
const shutdownCoordinator =
  createRuntimeShutdownCoordinator({
    timeoutMs: shutdownConfig.timeoutMs,
    async graceful() {
      const listenerDrain = new Promise<void>(
        (resolve, reject) => {
          httpServer.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        }
      );
      admissionReconciler.stop();
      httpServer.closeIdleConnections?.();
      await listenerDrain;
      await queueRuntime.close();
    },
    async force() {
      admissionReconciler.stop();
      httpServer.closeAllConnections?.();
      await queueRuntime.close();
    }
  });
installRuntimeSignalHandlers(shutdownCoordinator);
