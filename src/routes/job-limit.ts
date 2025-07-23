import { Router } from 'express';

const router = Router();

const CONCURRENT_LIMIT = 3;
let activeJobs = 0;

async function performJob(data: any): Promise<string> {
  // Simulate async work; replace with real logic
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return 'done';
}

router.post('/job', async (req, res) => {
  if (activeJobs >= CONCURRENT_LIMIT) {
    return res.status(429).json({ error: 'Too many jobs in progress' });
  }

  activeJobs++;
  try {
    const result = await performJob(req.body);
    res.json({ result });
  } catch (err: any) {
    res.status(500).json({ error: 'Job failed', details: err.message });
  } finally {
    activeJobs--;
  }
});

export default router;
