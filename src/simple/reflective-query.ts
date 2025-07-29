// ARCANOS Core Handler Patch (diagnostic + frontend safe)
import { Request, Response } from 'express';
import { getUnifiedOpenAI } from '../services/unified-openai';
import { OpenAIService } from '../services/openai'; // Keep for backward compatibility

const modesSupported = [
  'logic',
  'sim',
  'build',
  'audit',
  'write',
  'guide',
  'research',
  'tracker',
  'booking',
];

const unifiedOpenAI = getUnifiedOpenAI();
const openai = new OpenAIService(); // Keep for backward compatibility

export async function askHandler(req: Request, res: Response): Promise<void> {
  let { query, mode = 'logic', frontend = false } = req.body || {};

  if (/diagnose|what can you do|list modes/i.test(query || '')) {
    res.json({
      response: '🧠 ARCANOS System Capabilities',
      modes: modesSupported,
      flags: {
        frontend_filtering: true,
        reflection_default: true,
        debug_supported: true,
      },
      routing_notes: 'Query is routed to `runReflectiveLogic()` by default unless flagged.',
    });
    return;
  }

  const raw = await runReflectiveLogic(query);
  const response = frontend ? stripReflections(raw) : raw;
  res.json({ response });
}

async function runReflectiveLogic(query: string): Promise<string> {
  try {
    // Use unified service for better performance
    const response = await unifiedOpenAI.chat([
      { role: 'user', content: query }
    ]);
    
    if (response.success) {
      return response.content;
    } else {
      // Fallback to legacy service
      const fallbackResponse = await openai.chat([{ role: 'user', content: query }]);
      return fallbackResponse.message;
    }
  } catch (error) {
    console.error('Reflective logic failed:', error);
    return 'Reflective logic service temporarily unavailable.';
  }
}

function stripReflections(text: string): string {
  return text
    .replace(/I (observed|learned|think|reflect|believe|noticed)[^\.!\n]+[\.!\n]/gi, '')
    .replace(/This (taught|revealed|showed) me[^\.!\n]+[\.!\n]/gi, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}
