import { Router } from 'express';
import { ingestUrl, ingestContent, answerQuestion } from "@services/webRag.js";
import { asyncHandler, sendBadRequest } from '@shared/http/index.js';

const router = Router();

router.post('/rag/fetch', asyncHandler(async (req, res) => {
  const { url } = req.body;
  if (!url) {
    return sendBadRequest(res, 'url required');
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
    return sendBadRequest(res, 'content required');
  }
  if (id !== undefined && typeof id !== 'string') {
    return sendBadRequest(res, 'id must be a string when provided');
  }
  if (source !== undefined && typeof source !== 'string') {
    return sendBadRequest(res, 'source must be a string when provided');
  }
  let metadataObject: Record<string, unknown> | undefined;
  if (metadata !== undefined) {
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      return sendBadRequest(res, 'metadata must be an object when provided');
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
    return sendBadRequest(res, 'question required');
  }
  const result = await answerQuestion(question);
  res.json(result);
}));

export default router;

