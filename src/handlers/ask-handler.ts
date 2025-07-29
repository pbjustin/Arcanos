import { Request, Response } from 'express';
import { getUnifiedOpenAI, type FunctionDefinition } from '../services/unified-openai';
import { diagnosticsService } from '../services/diagnostics';
import { GameGuideService } from '../services/game-guide';
import { MemoryStorage } from '../storage/memory-storage';
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

// Get unified OpenAI service instance
const unifiedOpenAI = getUnifiedOpenAI();

// Command handler functions - Updated to use UnifiedOpenAIService
async function runFineTunedModel(prompt: string): Promise<string> {
  const response = await unifiedOpenAI.chat([
    { role: 'user', content: prompt }
  ], {
    model: aiConfig.fineTunedModel || "REDACTED_FINE_TUNED_MODEL_ID",
    temperature: 0.7,
  });
  
  if (!response.success) {
    throw new Error(response.error || 'Fine-tuned model request failed');
  }
  
  return response.content;
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

// Reflective logic runner - Updated to use UnifiedOpenAIService
async function runReflectiveLogic(query: string): Promise<string> {
  const response = await unifiedOpenAI.chat([
    { role: 'user', content: query }
  ]);
  
  if (!response.success) {
    throw new Error(response.error || 'Reflective logic failed');
  }
  
  return response.content;
}

// Consolidated command map
const commandMap: Record<string, (prompt: string) => Promise<string>> = {
  RUN_FINE_TUNED: runFineTunedModel,
  SIMULATE: runSimulation,
  DIAGNOSE: runSystemDiagnostics,
  ESTIMATE_COST: estimateCost,
  GUIDE: generateGuide,
};

// Enhanced functions for modern OpenAI features
const enhancedFunctions: FunctionDefinition[] = [
  {
    name: 'get_system_status',
    description: 'Get current system status and health metrics',
    parameters: {
      type: 'object',
      properties: {
        component: {
          type: 'string',
          enum: ['memory', 'database', 'openai', 'all'],
          description: 'System component to check'
        }
      },
      required: ['component']
    }
  },
  {
    name: 'search_memory',
    description: 'Search stored memories and reflections',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Maximum results to return' }
      },
      required: ['query']
    }
  },
  {
    name: 'generate_code',
    description: 'Generate code snippets based on requirements',
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', description: 'Programming language' },
        requirements: { type: 'string', description: 'Code requirements' },
        framework: { type: 'string', description: 'Framework to use (optional)' }
      },
      required: ['language', 'requirements']
    }
  }
];

// Function handlers for enhanced capabilities
const functionHandlers = {
  get_system_status: async (component: string) => {
    try {
      if (component === 'openai' || component === 'all') {
        const connectionTest = await unifiedOpenAI.testConnection();
        return {
          openai: {
            status: connectionTest.success ? 'healthy' : 'unhealthy',
            model: unifiedOpenAI.getModel(),
            error: connectionTest.error
          }
        };
      }
      return { status: 'Component status check not implemented yet' };
    } catch (error: any) {
      return { error: error.message };
    }
  },

  search_memory: async (query: string, limit: number = 10) => {
    try {
      // This would need to be implemented in MemoryStorage
      return { query, limit, message: 'Memory search not yet implemented' };
    } catch (error: any) {
      return { error: error.message };
    }
  },

  generate_code: async (language: string, requirements: string, framework?: string) => {
    try {
      const prompt = `Generate ${language} code for the following requirements: ${requirements}` +
        (framework ? ` using ${framework} framework` : '');
      
      const response = await unifiedOpenAI.chat([
        { role: 'system', content: 'You are an expert programmer. Generate clean, well-documented code.' },
        { role: 'user', content: prompt }
      ]);

      return {
        language,
        framework,
        code: response.content,
        success: response.success
      };
    } catch (error: any) {
      return { error: error.message };
    }
  }
};

// Main ask handler with unified structure and enhanced capabilities
async function askHandler(req: Request, res: Response) {
  const { 
    query, 
    frontend = false, 
    stream = false,
    enableFunctions = false 
  } = req.body || {};
  
  const cleaned = query.trim();
  const command = Object.keys(commandMap).find(cmd => cleaned.toUpperCase().startsWith(cmd));

  try {
    let response;

    if (command) {
      const prompt = cleaned.replace(new RegExp(command, 'i'), "").trim();
      response = await commandMap[command](prompt);
    } else if (enableFunctions) {
      // Use enhanced function calling
      const result = await unifiedOpenAI.chatWithFunctions(
        [{ role: 'user', content: cleaned }],
        enhancedFunctions,
        functionHandlers
      );
      
      if (!result.success) {
        throw new Error(result.error || 'Function calling failed');
      }
      
      response = result.content;
    } else if (stream && !frontend) {
      // Streaming response for non-frontend clients
      res.writeHead(200, {
        'Content-Type': 'text/plain',
        'Transfer-Encoding': 'chunked',
      });

      const streamResponse = await unifiedOpenAI.chatStream(
        [{ role: 'user', content: cleaned }],
        (chunk: string, isComplete: boolean) => {
          if (!isComplete) {
            res.write(chunk);
          } else {
            res.end();
          }
        }
      );

      // Queue reflection for streaming responses
      if (streamResponse.success) {
        queueReflection(cleaned, streamResponse.content);
      }
      
      return; // Response already sent via streaming
    } else {
      // Standard logic processing
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

export { 
  askHandler, 
  stripReflections, 
  queueReflection, 
  commandMap,
  enhancedFunctions,
  functionHandlers,
  unifiedOpenAI 
};