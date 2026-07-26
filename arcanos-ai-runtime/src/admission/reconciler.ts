import type { RuntimeAdmissionConfig } from "./config.js";
import type {
  RuntimeAdmissionReconciliationPort,
  RuntimeReconciliationCandidate
} from "./types.js";

export interface RuntimeReconciliationQueueJob {
  data: {
    principalId?: unknown;
  };
  getState(): Promise<string>;
}

export interface RuntimeReconciliationQueuePort {
  getJob(
    jobId: string
  ): Promise<RuntimeReconciliationQueueJob | null | undefined>;
}

export interface RuntimeAdmissionReconcilerLogger {
  error(event: string): void;
}

export interface CreateRuntimeAdmissionReconcilerOptions {
  admission: RuntimeAdmissionReconciliationPort;
  config: RuntimeAdmissionConfig;
  expectedPrincipalId: string;
  logger?: RuntimeAdmissionReconcilerLogger;
  queue: RuntimeReconciliationQueuePort;
}

export interface RuntimeAdmissionReconciler {
  runOnce(): Promise<void>;
  start(): void;
  stop(): void;
}

const TERMINAL_JOB_STATES = new Set([
  "completed",
  "failed"
]);
const NONTERMINAL_JOB_STATES = new Set([
  "active",
  "delayed",
  "paused",
  "prioritized",
  "queued",
  "wait",
  "waiting",
  "waiting-children"
]);

export function createRuntimeAdmissionReconciler(
  options: CreateRuntimeAdmissionReconcilerOptions
): RuntimeAdmissionReconciler {
  const logger = options.logger ?? console;
  let running = false;
  let timer: NodeJS.Timeout | null = null;

  async function reconcileCandidate(
    candidate: RuntimeReconciliationCandidate
  ): Promise<void> {
    let job: RuntimeReconciliationQueueJob | null | undefined;
    try {
      job = await options.queue.getJob(candidate.jobId);
    } catch {
      logger.error("ai_runtime.admission.reconcile_queue_unavailable");
      return;
    }

    if (!job) {
      try {
        const observation = await options.admission.observeMissing(
          candidate.jobId,
          options.expectedPrincipalId,
          options.config.missingConfirmMs
        );
        if (observation === "wrong_owner") {
          logger.error(
            "ai_runtime.admission.reconcile_owner_mismatch"
          );
        }
      } catch {
        logger.error(
          "ai_runtime.admission.reconcile_missing_unavailable"
        );
      }
      return;
    }

    if (
      job.data.principalId !== options.expectedPrincipalId
    ) {
      logger.error(
        "ai_runtime.admission.reconcile_job_owner_mismatch"
      );
      try {
        await options.admission.releaseReconciled(
          candidate.jobId,
          options.expectedPrincipalId
        );
      } catch {
        logger.error("ai_runtime.admission.release_deferred");
      }
      return;
    }

    let state: string;
    try {
      state = await job.getState();
    } catch {
      logger.error("ai_runtime.admission.reconcile_state_unavailable");
      return;
    }

    if (TERMINAL_JOB_STATES.has(state)) {
      try {
        await options.admission.releaseReconciled(
          candidate.jobId,
          options.expectedPrincipalId
        );
      } catch {
        logger.error("ai_runtime.admission.release_deferred");
      }
      return;
    }

    if (!NONTERMINAL_JOB_STATES.has(state)) {
      logger.error("ai_runtime.admission.reconcile_state_unknown");
      return;
    }

    try {
      const confirmation = await options.admission.confirmQueued(
        candidate.jobId,
        options.expectedPrincipalId
      );
      if (confirmation === "wrong_owner") {
        logger.error(
          "ai_runtime.admission.reconcile_owner_mismatch"
        );
      }
    } catch {
      logger.error(
        "ai_runtime.admission.reconcile_confirm_unavailable"
      );
    }
  }

  async function runOnce(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    try {
      const candidates =
        await options.admission.listReconciliationCandidates({
          pendingGraceMs: options.config.pendingGraceMs,
          liveGraceMs: options.config.claimGraceMs,
          batchSize: options.config.reconcileBatchSize
        });
      for (const candidate of candidates) {
        await reconcileCandidate(candidate);
      }
    } catch {
      logger.error("ai_runtime.admission.reconcile_unavailable");
    } finally {
      running = false;
    }
  }

  function start(): void {
    if (timer) {
      return;
    }
    void runOnce();
    timer = setInterval(() => {
      void runOnce();
    }, options.config.reconcileIntervalMs);
    timer.unref();
  }

  function stop(): void {
    if (!timer) {
      return;
    }
    clearInterval(timer);
    timer = null;
  }

  return { runOnce, start, stop };
}
