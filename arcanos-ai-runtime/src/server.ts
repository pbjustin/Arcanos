import express, { type Request, type Response, type NextFunction } from "express";
import { aiQueue } from "./queue/queue.js";
import { createJob, getJob } from "./jobs/jobStore.js";
import { config } from "./config.js";

const app = express();
app.use(express.json());

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const key = req.headers["x-api-key"];
  if (key !== config.apiKey) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

app.use(requireApiKey);

app.post("/jobs", async (req: Request, res: Response) => {
  const { model, messages, maxTokens } = req.body as {
    model?: unknown;
    messages?: unknown;
    maxTokens?: unknown;
  };

  if (typeof model !== "string" || !Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "model (string) and messages (non-empty array) required" });
    return;
  }

  const job = await createJob({
    model,
    messages,
    maxTokens: typeof maxTokens === "number" ? maxTokens : undefined,
  });
  await aiQueue.add("ai-job", { jobId: job.id });

  res.json({ jobId: job.id, status: "queued" });
});

app.get("/jobs/:id", async (req: Request, res: Response) => {
  const job = await getJob(req.params.id ?? "");
  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }
  res.json(job);
});

app.listen(config.port, () => {
  console.log(`API running on port ${config.port}`);
});
