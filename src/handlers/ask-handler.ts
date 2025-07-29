import { Request, Response } from 'express';
import { OpenAIService } from '../services/openai';
import { diagnosticsService } from '../services/diagnostics';
import { GameGuideService } from '../services/game-guide';
import { MemoryStorage } from '../storage/memory-storage';
import OpenAI from 'openai';
import { aiConfig } from '../config';

// Unified stripReflections helper for frontend filtering
function stripReflections(response: string): string {
  return response
    .replace(/^(Let me think about this\.\.\.|I'll reflect on this\.\.\.|Let me consider\.\.\.|I need to think about\.\.\.)[\s\S]*?\n\n/i, '')
    .replace(/\*\*(Reflection|Thinking|Analysis):\*\*[\s\S]*?(?=\n\n|\n\*\*|$)/gi, '')
    .replace(/\[(Reflection|Thinking|Analysis)\][\s\S]*?(?=\n\n|\n\[|$)/gi, '')
    .replace(/^---[\s\S]*?---\n\n/m, '')
    .trim();
}

// Background reflection storage - called once after main logic
function queueReflection(query: string, response: string): void {
  // Queue reflection for background storage
  setImmediate(async () => {
    try {
      const memoryStorage = new MemoryStorage();
      await memoryStorage.storeMemory(
        'system',
        'reflection-session',
        'system',
        `reflection_${Date.now()}`,
        {
          query,
          response,
          timestamp: new Date().toISOString()
        },
        ['reflection', 'background'],
        undefined
      );
    } catch (error) {
      console.error('Background reflection storage failed:', error);
    }
  });
}

// Command handler functions
async function runFineTunedModel(prompt: string): Promise<string> {
  const apiKey = aiConfig.openaiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key is required for fine-tuned model routing');
  }
  
  const openaiClient = new OpenAI({
    apiKey: apiKey,
    timeout: 30000,
    maxRetries: 3,
  });

  const completion = await openaiClient.chat.completions.create({
    model: aiConfig.fineTunedModel || "REDACTED_FINE_TUNED_MODEL_ID",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });
  
  return completion.choices[0]?.message?.content || "";
}

async function runSimulation(prompt: string): Promise<string> {
  const gameGuideService = new GameGuideService();
  
  // Extract game title from prompt (simple extraction for demo)
  const gameTitle = prompt.replace(/simulate|simulation/gi, '').trim() || 'Strategy Game';
  
  const result = await gameGuideService.simulateGameGuide(gameTitle, prompt);
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  return result.guide;
}

async function runSystemDiagnostics(prompt: string): Promise<string> {
  const result = await diagnosticsService.executeDiagnosticCommand(prompt);
  
  if (!result.success) {
    throw new Error(result.error || 'Diagnostic command failed');
  }
  
  return JSON.stringify(result.data, null, 2);
}

async function estimateCost(prompt: string): Promise<string> {
  // Simple cost estimation based on prompt length and complexity
  const words = prompt.split(/\s+/).length;
  const complexity = prompt.includes('complex') || prompt.includes('detailed') ? 'high' : 'medium';
  const estimatedTokens = words * 1.3; // rough estimate
  const costPer1000Tokens = 0.002; // example rate
  const estimatedCost = (estimatedTokens / 1000) * costPer1000Tokens;
  
  return `Estimated cost for "${prompt.substring(0, 50)}...": $${estimatedCost.toFixed(4)} (${Math.round(estimatedTokens)} tokens, ${complexity} complexity)`;
}

async function generateGuide(prompt: string): Promise<string> {
  const gameGuideService = new GameGuideService();
  const topic = prompt.replace(/guide|how.*to/gi, '').trim() || 'General Topic';
  
  const result = await gameGuideService.simulateGameGuide(`${topic} Guide`, prompt);
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  return result.guide;
}

// Reflective logic runner
async function runReflectiveLogic(query: string): Promise<string> {
  const openaiService = new OpenAIService();
  const result = await openaiService.chat([{ role: 'user', content: query }]);
  
  if (result.error) {
    throw new Error(result.error);
  }
  
  return result.message;
}

// Consolidated command map
const commandMap: Record<string, (prompt: string) => Promise<string>> = {
  RUN_FINE_TUNED: runFineTunedModel,
  SIMULATE: runSimulation,
  DIAGNOSE: runSystemDiagnostics,
  ESTIMATE_COST: estimateCost,
  GUIDE: generateGuide,
};

// Main ask handler with unified structure
async function askHandler(req: Request, res: Response) {
  const { query, frontend = false, mode = "logic" } = req.body || {};
  const cleaned = query.trim();
  const command = Object.keys(commandMap).find(cmd => cleaned.toUpperCase().startsWith(cmd));

  try {
    let response;

    if (command) {
      const prompt = cleaned.replace(new RegExp(command, 'i'), "").trim();
      response = await commandMap[command](prompt);
    } else {
      const raw = await runReflectiveLogic(cleaned);
      queueReflection(cleaned, raw);
      response = frontend ? stripReflections(raw) : raw;
    }

    return res.json({ response });

  } catch (err) {
    console.error("Error in askHandler:", err);
    return res.status(500).json({ error: "Internal logic error." });
  }
}

export { askHandler, stripReflections, queueReflection, commandMap };