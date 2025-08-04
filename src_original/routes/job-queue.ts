import { Router } from 'express';
import { enqueue } from '../services/jobQueue.js';

const router = Router();

router.post('/enqueue', (req, res) => {
  enqueue(req.body);
  res.json({ queued: true });
});

export default router;
