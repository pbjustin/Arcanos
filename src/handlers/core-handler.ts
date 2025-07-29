import { Request, Response } from 'express';
import { getUnifiedOpenAI } from '../services/unified-openai';
import { aiConfig } from '../config';

// Use unified OpenAI service
const unifiedOpenAI = getUnifiedOpenAI();

export async function askHandler(req: Request, res: Response): Promise<void> {
  const { query, useFineTuned = false, frontend = false } = req.body;

  try {
    if (useFineTuned || /finetune|ft:/i.test(query)) {
      try {
        // Use unified service for fine-tuned model requests
        const response = await unifiedOpenAI.chat([
          { role: "user", content: query }
        ], {
          model: aiConfig.fineTunedModel || "gpt-4-turbo",
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
  const result = await unifiedOpenAI.chat([{ role: 'user', content: query }]);
  
  if (!result.success) {
    throw new Error(result.error || 'Chat request failed');
  }
  
  return result.content;
}

function stripReflections(text: string): string {
  return text
    .replace(/I (observed|learned|think|reflect|believe|noticed)[^\.!\n]+[\.!\n]/gi, '')
    .replace(/This (taught|revealed|showed) me[^\.!\n]+[\.!\n]/gi, '')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
}
