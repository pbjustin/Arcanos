import { Request, Response } from 'express';
import { sendToFinetune, sendToCore } from '../services/finetune';

function isFallback(query: string): boolean {
  return query.includes('--fallback') || query.includes('::default');
}

export default async (req: Request, res: Response) => {
  const { query, mode = 'logic' } = req.body;
  
  if (!query) {
    console.log('❌ Copilot router: Missing query field');
    return res.status(400).json({ error: 'Missing query field' });
  }

  try {
    const fallbackDetected = isFallback(query);
    const cleanedQuery = query.replace('--fallback', '').replace('::default', '').trim();
    
    console.log(`🚀 Copilot router: Processing query (fallback: ${fallbackDetected})`);
    console.log(`📝 Original query: "${query}"`);
    console.log(`🧹 Cleaned query: "${cleanedQuery}"`);
    console.log(`🎯 Mode: ${mode}`);
    console.log(`🔀 Route: ${fallbackDetected ? 'core' : 'finetune'}`);
    
    const response = fallbackDetected
      ? await sendToCore(cleanedQuery, mode)
      : await sendToFinetune(cleanedQuery, mode);
    
    console.log(`✅ Copilot router: Response received from ${fallbackDetected ? 'core' : 'finetune'}`);
    res.json({ response });
  } catch (err: any) {
    console.error('❌ Copilot router error:', err.message);
    res.status(500).json({ error: err.message });
  }
};