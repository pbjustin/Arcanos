import express from 'express';
import { z } from 'zod';
import { getJobById } from "@core/db/repositories/jobRepository.js";
import { asyncHandler, validateParams, sendNotFound } from '@shared/http/index.js';

const router = express.Router();

const jobIdSchema = z.object({
  id: z.string().min(1)
});

router.get(
  '/jobs/:id',
  validateParams(jobIdSchema, { errorCode: 'JOB_ID_INVALID' }),
  asyncHandler(async (req, res) => {
    const { id } = req.validated!.params as z.infer<typeof jobIdSchema>;

    const job = await getJobById(id);
    if (!job) {
      sendNotFound(res, 'JOB_NOT_FOUND');
      return;
    }

    res.json({
      id: job.id,
      job_type: job.job_type,
      status: job.status,
      created_at: job.created_at,
      updated_at: job.updated_at,
      completed_at: job.completed_at ?? null,
      error_message: job.error_message ?? null,
      output: job.output ?? null
    });
  })
);

export default router;
