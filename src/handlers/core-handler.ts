import { Request, Response } from 'express';
import { OpenAIService } from '../services/openai';

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

const openai = new OpenAIService();

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
  const result = await openai.chat([{ role: 'user', content: query }]);
  return result.message;
}

function stripReflections(text: string): string {
  return text
    .replace(/I (observed|learned|think|reflect|believe|noticed)[^\.!\n]+[\.!\n]/gi, '')
    .replace(/This (taught|revealed|showed) me[^\.!\n]+[\.!\n]/gi, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}
