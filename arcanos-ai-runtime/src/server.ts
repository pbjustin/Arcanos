import express from "express";
import { aiQueue } from "./queue/queue";
import { createJob, getJob } from "./jobs/jobStore";

const app = express();
app.use(express.json());

app.post("/jobs", async (req, res) => {
  if (!req.body.model || !req.body.messages) {
    return res.status(400).json({ error: "model and messages required" });
  }

  const job = createJob(req.body);
  await aiQueue.add("ai-job", { jobId: job.id });

  res.json({ jobId: job.id, status: "queued" });
});

app.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`API running on port ${PORT}`);
});
