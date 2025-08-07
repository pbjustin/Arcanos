import OpenAI from 'openai';
import { createResponseWithLogging } from '../utils/aiLogger.js';
import { runHealthCheck } from '../utils/diagnostics.js';
import { getDefaultModel } from '../services/openai.js';

interface ArcanosResult {
  result: string;
  componentStatus: string;
  suggestedFixes: string;
  coreLogicTrace: string;
  meta: {
    tokens?: {
      prompt_tokens: number;
      completion_tokens: number;
      total_tokens: number;
    } | undefined;
    id: string;
    created: number;
  };
}

/**
 * Wrap prompt before sending to GPT-4 with ARCANOS diagnostic format
 */
export const arcanosPrompt = (userInput: string): string => `
You are ARCANOS — a modular AI operating core.
Respond with full system diagnostic capability.

[USER COMMAND]
${userInput}

[RESPONSE FORMAT]
- ✅ Component Status Table
- 🛠 Suggested Fixes
- 🧠 Core Logic Trace
`;

/**
 * Execute ARCANOS system diagnosis with structured response using the fine-tuned model
 */
export async function runARCANOS(client: OpenAI, userInput: string): Promise<ArcanosResult> {
  console.log('[🔬 ARCANOS] Running system diagnosis...');
  
  // Get current system health for context
  const health = await runHealthCheck();
  
  // Create the ARCANOS prompt with shell wrapper
  const prompt = arcanosPrompt(userInput);
  
  // Add system context to help with diagnostics
  const systemContext = `
Current System Status:
- Memory Usage: ${health.summary}
- Node.js Version: ${process.version}
- Platform: ${process.platform}
- Architecture: ${process.arch}
- Environment: ${process.env.NODE_ENV || 'development'}
- Uptime: ${process.uptime().toFixed(1)}s

${prompt}`;

  // Use the fine-tuned model with fallback to gpt-4
  const defaultModel = getDefaultModel();
  let modelToUse = defaultModel;
  
  try {
    // Try the fine-tuned model first
    const response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: 'You are ARCANOS, an AI operating core. Provide detailed system diagnostics in the exact format requested. Be precise and actionable.'
        },
        {
          role: 'user',
          content: systemContext
        }
      ],
      temperature: 0.1, // Low temperature for consistent diagnostic output
      max_tokens: 2000,
    });

    const fullResult = response.choices[0]?.message?.content || '';
    console.log(`[🔬 ARCANOS] Diagnosis complete using model: ${modelToUse}`);
    
    return parseArcanosResponse(fullResult, response);
  } catch (err) {
    console.warn(`⚠️  Fine-tuned model failed, falling back to gpt-4: ${err instanceof Error ? err.message : 'Unknown error'}`);
    modelToUse = 'gpt-4';
    
    const response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: 'You are ARCANOS, an AI operating core. Provide detailed system diagnostics in the exact format requested. Be precise and actionable.'
        },
        {
          role: 'user',
          content: systemContext
        }
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });

    const fullResult = response.choices[0]?.message?.content || '';
    console.log(`[🔬 ARCANOS] Diagnosis complete using fallback model: ${modelToUse}`);
    
    return parseArcanosResponse(fullResult, response);
  }
}

function parseArcanosResponse(fullResult: string, response: OpenAI.Chat.Completions.ChatCompletion): ArcanosResult {
  // Parse the structured response
  const componentStatusMatch = fullResult.match(/✅ Component Status Table\s*([\s\S]*?)(?=🛠|$)/);
  const suggestedFixesMatch = fullResult.match(/🛠 Suggested Fixes\s*([\s\S]*?)(?=🧠|$)/);
  const coreLogicTraceMatch = fullResult.match(/🧠 Core Logic Trace\s*([\s\S]*?)$/);
  
  const componentStatus = componentStatusMatch ? componentStatusMatch[1].trim() : 'Status information not available';
  const suggestedFixes = suggestedFixesMatch ? suggestedFixesMatch[1].trim() : 'No fixes suggested';
  const coreLogicTrace = coreLogicTraceMatch ? coreLogicTraceMatch[1].trim() : 'Logic trace not available';

  return {
    result: fullResult,
    componentStatus,
    suggestedFixes,
    coreLogicTrace,
    meta: {
      tokens: response.usage || undefined,
      id: response.id,
      created: response.created,
    },
  };
}