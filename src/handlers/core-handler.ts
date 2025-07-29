import { Request, Response } from 'express';
import { getUnifiedOpenAI } from '../services/unified-openai';
import { OpenAIService } from '../services/openai'; // Keep for backward compatibility
import { aiConfig } from '../config';

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

// Use unified OpenAI service
const unifiedOpenAI = getUnifiedOpenAI();
const openai = new OpenAIService(); // Keep for backward compatibility

export async function askHandler(req: Request, res: Response): Promise<void> {
  const { query, mode = "logic", useFineTuned = false, frontend = false } = req.body;

  try {
    if (useFineTuned || /finetune|ft:/i.test(query)) {
      try {
        // Use unified service for fine-tuned model requests
        const response = await unifiedOpenAI.chat([
          { role: "user", content: query }
        ], {
          model: aiConfig.fineTunedModel || "REDACTED_FINE_TUNED_MODEL_ID",
          temperature: 0.7,
        });
        
        if (response.success) {
          res.json({ response: frontend ? stripReflections(response.content) : response.content });
          return;
        } else {
          console.error('Fine-tuned route failed, falling back to reflective logic:', response.error);
          // Fall through to reflective logic
        }
      } catch (ftError) {
        console.error('Fine-tuned route failed, falling back to reflective logic:', ftError);
        // Fall through to reflective logic
      }
    }

    const raw = await runReflectiveLogic(query);
    res.json({ response: frontend ? stripReflections(raw) : raw });
    return;

  } catch (error: any) {
    console.error("Routing or model error:", error);
    res.status(500).json({ error: "AI route failed." });
    return;
  }
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
