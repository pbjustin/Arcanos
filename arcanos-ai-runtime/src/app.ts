import { randomUUID } from "node:crypto";
import express, {
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type Response
} from "express";

import type {
  RuntimeAdmissionPort,
  RuntimeConfirmationDecision
} from "./admission/types.js";
import {
  AI_RUNTIME_ENQUEUE_SCOPE,
  AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID,
  AI_RUNTIME_READ_SCOPE,
  createAiRuntimeAuthenticationMiddleware,
  getAiRuntimeHttpPrincipal,
  requireAiRuntimeScope
} from "./auth/runtimeHttpAuth.js";
import {
  sendBadRequest,
  sendInternalErrorPayload,
  sendNotFound
} from "./http/errors.js";
import { projectPublicJobResult } from "./jobs/publicResult.js";
import { resolveRuntimeJobPolicy } from "./jobs/policy.js";
import type { RuntimeJobStatus } from "./jobs/types.js";
import { validateCreateJobInput } from "./jobs/validation.js";
import type {
  RuntimeQueueJob,
  RuntimeQueuePort
} from "./queue/types.js";

export type {
  RuntimeQueueJob,
  RuntimeQueuePort
} from "./queue/types.js";

const JSON_BODY_LIMIT = "256kb";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RuntimeHttpLogger {
  error(event: string): void;
}

export interface RuntimeReadinessPort {
  isReady(): boolean;
}

export interface CreateRuntimeAppOptions {
  queue: RuntimeQueuePort;
  admission: RuntimeAdmissionPort;
  environment?: NodeJS.ProcessEnv;
  generateJobId?: () => string;
  logger?: RuntimeHttpLogger;
  readiness?: RuntimeReadinessPort;
}

function setRetryAfterHeader(res: Response, retryAfterMs: number): void {
  const retryAfterSeconds = Number.isFinite(retryAfterMs)
    ? Math.max(1, Math.ceil(retryAfterMs / 1000))
    : 1;
  res.setHeader("Retry-After", String(retryAfterSeconds));
}

function mapQueueStateToStatus(state: string): RuntimeJobStatus {
  switch (state) {
    case "active":
      return "processing";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "queued";
  }
}

function buildJobResponse(
  job: RuntimeQueueJob,
  status: RuntimeJobStatus
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    jobId: String(job.id),
    status,
    model: job.data.model,
    createdAt: job.timestamp,
    startedAt: job.processedOn ?? null,
    finishedAt: job.finishedOn ?? null
  };

  if (job.data.maxTokens !== undefined) {
    response.maxTokens = job.data.maxTokens;
  }

  if (status === "completed") {
    const projection = projectPublicJobResult(job.returnvalue);
    if (projection.ok) {
      response.result = projection.result;
    } else {
      response.status = "failed";
      response.error = "Job execution failed";
    }
  }

  if (status === "failed") {
    response.error = "Job execution failed";
  }

  return response;
}

function setRuntimeSecurityHeaders(
  _req: Request,
  res: Response,
  next: () => void
): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; frame-ancestors 'none'; base-uri 'none'"
  );
  next();
}

function isErrorRecord(value: unknown): value is {
  status?: unknown;
  type?: unknown;
} {
  return value !== null && typeof value === "object";
}

export function createRuntimeApp(options: CreateRuntimeAppOptions) {
  const environment = options.environment ?? process.env;
  const generateJobId = options.generateJobId ?? randomUUID;
  const logger = options.logger ?? console;
  const jobPolicy = resolveRuntimeJobPolicy(environment);

  const app = express();
  app.disable("x-powered-by");
  app.use(setRuntimeSecurityHeaders);
  app.get(["/health", "/healthz"], (_req, res) => {
    res.status(200).json({ status: "ok" });
  });
  app.get("/readyz", (_req, res) => {
    if (options.readiness?.isReady() !== true) {
      res.status(503).json({ status: "unavailable" });
      return;
    }
    res.status(200).json({ status: "ready" });
  });
  app.use("/jobs", createAiRuntimeAuthenticationMiddleware(environment));

  app.post(
    "/jobs",
    requireAiRuntimeScope(AI_RUNTIME_ENQUEUE_SCOPE),
    (_req, res, next) => {
      if (!jobPolicy) {
        res.status(503).json({
          error: {
            code: "AI_RUNTIME_JOB_POLICY_UNAVAILABLE",
            message: "AI runtime job policy is unavailable."
          }
        });
        return;
      }
      next();
    },
    async (
      req: Request,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const principal = getAiRuntimeHttpPrincipal(req);
      if (!principal) {
        sendInternalErrorPayload(res, {
          error: "AI_RUNTIME_AUTH_CONTEXT_MISSING"
        });
        return;
      }

      try {
        const rateDecision =
          await options.admission.consumeEnqueueRate(
            principal.principalId
          );
        if (rateDecision.kind === "rate_limited") {
          setRetryAfterHeader(res, rateDecision.retryAfterMs);
          res.status(429).json({
            error: {
              code: "AI_RUNTIME_RATE_LIMITED",
              message: "AI runtime enqueue rate limit exceeded."
            }
          });
          return;
        }
        if (rateDecision.kind !== "allowed") {
          throw new Error("Invalid AI runtime rate decision");
        }
      } catch {
        logger.error("ai_runtime.admission.rate_unavailable");
        res.status(503).json({
          error: {
            code: "AI_RUNTIME_ADMISSION_UNAVAILABLE",
            message: "AI runtime admission is unavailable."
          }
        });
        return;
      }

      next();
    },
    express.json({ limit: JSON_BODY_LIMIT }),
    async (req, res) => {
      const principal = getAiRuntimeHttpPrincipal(req);
      if (!principal) {
        return sendInternalErrorPayload(res, {
          error: "AI_RUNTIME_AUTH_CONTEXT_MISSING"
        });
      }
      if (!jobPolicy) {
        return sendInternalErrorPayload(res, {
          error: "AI_RUNTIME_JOB_POLICY_CONTEXT_MISSING"
        });
      }

      const validation = validateCreateJobInput(req.body, jobPolicy);
      if (!validation.ok) {
        return sendBadRequest(res, validation.error);
      }

      const jobId = generateJobId();
      try {
        const reservation = await options.admission.reserve({
          jobId,
          principalId: principal.principalId
        });
        if (reservation.kind === "saturated") {
          setRetryAfterHeader(res, reservation.retryAfterMs);
          return res.status(503).json({
            error: {
              code: "AI_RUNTIME_QUEUE_SATURATED",
              message: "AI runtime queue is at capacity."
            }
          });
        }
        if (reservation.kind !== "granted") {
          throw new Error("Invalid AI runtime reservation decision");
        }
      } catch {
        logger.error("ai_runtime.admission.reserve_unavailable");
        return res.status(503).json({
          error: {
            code: "AI_RUNTIME_ADMISSION_UNAVAILABLE",
            message: "AI runtime admission is unavailable."
          }
        });
      }

      let queued = false;
      try {
        await options.queue.add(
          "ai-job",
          {
            ...validation.data,
            principalId: principal.principalId
          },
          { jobId }
        );
        queued = true;
      } catch {
        logger.error("ai_runtime.jobs.enqueue_failed");
        try {
          const existingJob = await options.queue.getJob(jobId);
          queued =
            existingJob?.data.principalId ===
            principal.principalId;
          if (
            existingJob &&
            existingJob.data.principalId !==
              principal.principalId
          ) {
            logger.error(
              "ai_runtime.jobs.enqueue_id_collision"
            );
          }
        } catch {
          logger.error("ai_runtime.jobs.enqueue_outcome_unknown");
        }
      }

      if (!queued) {
        return sendInternalErrorPayload(res, {
          error: "Failed to enqueue job"
        });
      }

      let confirmation: RuntimeConfirmationDecision | undefined;
      try {
        confirmation = await options.admission.confirmQueued(
          jobId,
          principal.principalId
        );
      } catch {
        logger.error("ai_runtime.admission.confirm_deferred");
      }
      if (confirmation === "wrong_owner") {
        logger.error("ai_runtime.admission.confirm_owner_mismatch");
        return sendInternalErrorPayload(res, {
          error: "Failed to enqueue job"
        });
      }
      if (
        confirmation !== undefined &&
        confirmation !== "confirmed" &&
        confirmation !== "already_confirmed" &&
        confirmation !== "already_released"
      ) {
        logger.error("ai_runtime.admission.confirm_invalid");
        return sendInternalErrorPayload(res, {
          error: "Failed to enqueue job"
        });
      }

      return res.status(202).json({ jobId, status: "queued" });
    }
  );

  app.get(
    "/jobs/:id",
    requireAiRuntimeScope(AI_RUNTIME_READ_SCOPE),
    async (req, res) => {
      const principal = getAiRuntimeHttpPrincipal(req);
      if (!principal) {
        return sendInternalErrorPayload(res, {
          error: "AI_RUNTIME_AUTH_CONTEXT_MISSING"
        });
      }

      const jobId = req.params.id?.trim();
      if (!jobId || !UUID_V4_PATTERN.test(jobId)) {
        return sendBadRequest(res, "Job ID must be a UUID");
      }

      try {
        const job = await options.queue.getJob(jobId);
        if (
          !job ||
          job.data.principalId ===
            AI_RUNTIME_LEGACY_ANONYMOUS_PRINCIPAL_ID ||
          job.data.principalId !== principal.principalId
        ) {
          return sendNotFound(res, "Job not found");
        }

        const status = mapQueueStateToStatus(await job.getState());
        return res.json(buildJobResponse(job, status));
      } catch {
        logger.error("ai_runtime.jobs.read_failed");
        return sendInternalErrorPayload(res, {
          error: "Failed to read job status"
        });
      }
    }
  );

  app.use("/jobs", (_req, res) => {
    return sendNotFound(res, "Route not found");
  });

  app.use((_req, res) => {
    return sendNotFound(res, "Route not found");
  });

  const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    if (isErrorRecord(error) && error.type === "entity.too.large") {
      res.status(413).json({ error: "Request body is too large" });
      return;
    }

    if (isErrorRecord(error) && error.type === "entity.parse.failed") {
      res.status(400).json({ error: "Request body must be valid JSON" });
      return;
    }

    logger.error("ai_runtime.http.unhandled_error");
    res.status(500).json({ error: "Internal server error" });
  };
  app.use(errorHandler);

  return app;
}
