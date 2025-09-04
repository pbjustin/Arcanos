import { Router } from 'express';
import { ingestUrl, answerQuestion } from '../services/webRag.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = Router();

router.post('/rag/fetch', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }
  const doc = await ingestUrl(url);
  res.json({ id: doc.id, url: doc.url, contentLength: doc.content.length });
}));

router.post('/rag/query', asyncHandler(async (req, res) => {
  const { question } = req.body;
  if (!question) {
    return res.status(400).json({ error: 'question required' });
  }
  const result = await answerQuestion(question);
  res.json(result);
}));

export default router;
