import express, { Request, Response } from 'express';
import { z } from 'zod';
import { getJobById } from "@core/db/repositories/jobRepository.js";

const router = express.Router();

const jobIdSchema = z.object({
  id: z.string().min(1)
});

router.get('/jobs/:id', async (req: Request, res: Response) => {
  const parsed = jobIdSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({ error: 'JOB_ID_INVALID' });
  }

  const job = await getJobById(parsed.data.id);
  if (!job) {
    return res.status(404).json({ error: 'JOB_NOT_FOUND' });
  }

  return res.json({
    id: job.id,
    job_type: job.job_type,
    status: job.status,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at ?? null,
    error_message: job.error_message ?? null,
    output: job.output ?? null
  });
});

export default router;
