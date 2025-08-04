import { Request, Response, NextFunction } from 'express';

/**
 * General-purpose response handler for oversized or complex data.
 * If payload is small enough, respond directly. Otherwise split into chunks.
 * Compatible with existing dispatcher and OpenAI SDK usage patterns.
 */
export function responseWorker(req: Request, res: Response, _next: NextFunction): void {
  const payload = req.body || {};
  const { taskType = 'generic', resultData = null } = payload;

  try {
    if (resultData === null || resultData === undefined) {
      throw new Error('Missing resultData from upstream logic.');
    }

    const sizeLimit = 8000; // bytes
    const content = JSON.stringify(resultData);

    if (content.length <= sizeLimit) {
      res.status(200).json({ status: 'ok', type: taskType, result: resultData });
      return;
    }

    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += sizeLimit) {
      chunks.push(content.slice(i, i + sizeLimit));
    }

    res.status(200).json({
      status: 'partial',
      type: taskType,
      chunks,
      metadata: {
        totalChunks: chunks.length,
        timestamp: Date.now(),
        handler: 'responseWorker',
        recombine: true
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: 'responseWorker failure', details: err.message });
  }
}
