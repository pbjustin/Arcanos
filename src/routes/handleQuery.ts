import { Request, Response } from 'express';
import { sendToFinetune, sendToCore } from '../services/finetune';

function isFallback(query: string): boolean {
  return query.includes('--fallback') || query.includes('::default');
}

export default async (req: Request, res: Response) => {
  const { query, mode = 'logic' } = req.body;
  
  if (!query) {
    return res.status(400).json({ error: 'Missing query field' });
  }

  try {
    const cleanedQuery = query.replace('--fallback', '').replace('::default', '').trim();
    const response = isFallback(query)
      ? await sendToCore(cleanedQuery, mode)
      : await sendToFinetune(cleanedQuery, mode);
    res.json({ response });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
};