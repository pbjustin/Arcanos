import express from "express";
import { randomUUID } from "node:crypto";
import type { Job } from "bullmq";
import { aiQueue } from "./queue/queue";
import { getRequestAuth, requireApiKey } from "./auth/apiKey";
import { runtimeEnv } from "./config/env";
import type { AIJobPayload, RuntimeJobStatus } from "./jobs/types";
import { validateCreateJobInput } from "./jobs/validation";

const JSON_BODY_LIMIT = "256kb";

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
  job: Job<AIJobPayload>,
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
    response.result = job.returnvalue;
  }

  if (status === "failed") {
    response.error = job.failedReason ?? "Job execution failed";
  }

  return response;
}

const app = express();
app.use(express.json({ limit: JSON_BODY_LIMIT }));
app.use("/jobs", requireApiKey);

app.post("/jobs", async (req, res) => {
  const validation = validateCreateJobInput(req.body);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  try {
    const auth = getRequestAuth(req);
    if (!auth) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const jobId = randomUUID();

    await aiQueue.add(
      "ai-job",
      {
        ...validation.data,
        principalId: auth.principalId
      },
      { jobId }
    );

    return res.status(202).json({ jobId, status: "queued" });
  } catch (error) {
    console.error("Failed to enqueue job", error);
    return res.status(500).json({ error: "Failed to enqueue job" });
  }
});

app.get("/jobs/:id", async (req, res) => {
  const jobId = req.params.id?.trim();
  if (!jobId) {
    return res.status(400).json({ error: "Job ID is required" });
  }

  try {
    const auth = getRequestAuth(req);
    if (!auth) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const job = await aiQueue.getJob(jobId);
    if (!job) {
      return res.status(404).json({ error: "Job not found" });
    }

    if (job.data.principalId !== auth.principalId) {
      return res
        .status(403)
        .json({ error: "Not authorized to access this job" });
    }

    const status = mapQueueStateToStatus(await job.getState());
    return res.json(buildJobResponse(job, status));
  } catch (error) {
    console.error("Failed to read job", error);
    return res.status(500).json({ error: "Failed to read job status" });
  }
});

app.listen(runtimeEnv.PORT, () => {
  console.log(`API running on port ${runtimeEnv.PORT}`);
});
