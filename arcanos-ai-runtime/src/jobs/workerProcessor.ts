import type { RuntimeAdmissionPort } from "../admission/types.js";
import type { RuntimeJobPolicy } from "./policy.js";
import {
  processQueuedAIJob,
  type RuntimeJobExecutor
} from "./processJob.js";

export interface RuntimeWorkerJob {
  id?: string | number;
  token?: string;
  data: unknown;
}

export interface RuntimeWorkerProcessorLogger {
  error(event: string): void;
}

export interface CreateRuntimeWorkerProcessorOptions {
  admission: RuntimeAdmissionPort;
  expectedPrincipalId: string;
  policy: RuntimeJobPolicy;
  execute?: RuntimeJobExecutor;
}

export function createRuntimeWorkerProcessor(
  options: CreateRuntimeWorkerProcessorOptions
): (job: RuntimeWorkerJob) => Promise<unknown> {
  return async (job) => {
    const jobId =
      job.id === undefined ? "" : String(job.id).trim();
    if (!jobId) {
      throw new Error("Queued AI job ID failed validation");
    }
    const claimId = job.token?.trim();
    if (!claimId) {
      throw new Error("Queued AI job claim ID failed validation");
    }

    const claim = await options.admission.claimForExecution(
      jobId,
      options.expectedPrincipalId,
      claimId
    );
    if (claim !== "claimed") {
      throw new Error("Queued AI job admission claim failed");
    }

    return processQueuedAIJob(job.data, {
      expectedPrincipalId: options.expectedPrincipalId,
      policy: options.policy,
      ...(options.execute ? { execute: options.execute } : {})
    });
  };
}

export function createRuntimeTerminalReleaseHandler(
  admission: RuntimeAdmissionPort,
  expectedPrincipalId: string,
  logger: RuntimeWorkerProcessorLogger = console
): (job: RuntimeWorkerJob | undefined) => Promise<void> {
  return async (job) => {
    const jobId =
      job?.id === undefined ? "" : String(job.id).trim();
    const payload =
      job?.data !== null &&
      typeof job?.data === "object" &&
      !Array.isArray(job.data)
        ? (job.data as Record<string, unknown>)
        : null;
    const claimId = job?.token?.trim();
    if (
      !jobId ||
      !claimId ||
      payload?.principalId !== expectedPrincipalId
    ) {
      logger.error("ai_runtime.admission.terminal_job_invalid");
      return;
    }

    try {
      await admission.releaseTerminal(
        jobId,
        expectedPrincipalId,
        claimId
      );
    } catch {
      logger.error("ai_runtime.admission.release_deferred");
    }
  };
}
