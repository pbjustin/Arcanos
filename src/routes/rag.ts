import { Router } from 'express';
import { ingestUrl, ingestContent, answerQuestion } from "@services/webRag.js";
import { asyncHandler } from "@transport/http/asyncHandler.js";

const router = Router();

router.post('/rag/fetch', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: 'url required' });
  }
  const result = await ingestUrl(url);
  res.json({
    id: result.parentId,
    parentId: result.parentId,
    url: result.source,
    chunkCount: result.chunkCount,
    contentLength: result.contentLength,
    metadata: result.metadata,
  });
}));

router.post('/rag/save', asyncHandler(async (req, res) => {
  const { id, content, source, metadata } = req.body ?? {};
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content required' });
  }
  if (id !== undefined && typeof id !== 'string') {
    return res.status(400).json({ error: 'id must be a string when provided' });
  }
  if (source !== undefined && typeof source !== 'string') {
    return res.status(400).json({ error: 'source must be a string when provided' });
  }
  let metadataObject: Record<string, unknown> | undefined;
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return res.status(400).json({ error: 'metadata must be an object when provided' });
    }
    metadataObject = metadata as Record<string, unknown>;
  }

  const result = await ingestContent({ id, content, source, metadata: metadataObject });
  res.json({
    id: result.parentId,
    parentId: result.parentId,
    source: result.source,
    chunkCount: result.chunkCount,
    contentLength: result.contentLength,
    metadata: result.metadata,
  });
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

