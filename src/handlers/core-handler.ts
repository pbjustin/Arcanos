import { Request, Response } from 'express';
import { OpenAIService } from '../services/openai';
import OpenAI from 'openai';
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

const openai = new OpenAIService();

// Direct OpenAI client for fine-tuned model routing
let openaiClient: OpenAI | null = null;

// Get direct OpenAI client for fine-tuned routing
function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = aiConfig.openaiApiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required for fine-tuned model routing');
    }
    openaiClient = new OpenAI({
      apiKey: apiKey,
      timeout: 30000,
      maxRetries: 3,
    });
  }
  return openaiClient;
}

export async function askHandler(req: Request, res: Response): Promise<void> {
  const { query, mode = "logic", useFineTuned = false, frontend = false } = req.body;

  try {
    if (useFineTuned || /finetune|ft:/i.test(query)) {
      try {
        const openaiDirect = getOpenAIClient();
        const completion = await openaiDirect.chat.completions.create({
          model: aiConfig.fineTunedModel || "ft:gpt-3.5-turbo-0125:your-org:model-id", // replace with actual ID
          messages: [{ role: "user", content: query }],
          temperature: 0.7,
        });
        const response = completion.choices[0]?.message?.content || "";
        res.json({ response: frontend ? stripReflections(response) : response });
        return;
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
