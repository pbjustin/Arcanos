import { Router } from 'express';

const router = Router();

// Basic /ask endpoint
router.post('/ask', (_req, res) => {
  res.status(200).json({ success: true, message: 'Ask endpoint is operational.' });
});

export default router;

