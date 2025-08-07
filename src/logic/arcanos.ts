import OpenAI from 'openai';
import { createResponseWithLogging } from '../utils/aiLogger.js';
import { runHealthCheck } from '../utils/diagnostics.js';

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
 * Execute ARCANOS system diagnosis with structured response
 */
export async function runARCANOS(client: OpenAI, userInput: string): Promise<ArcanosResult> {
  console.log('[🔬 ARCANOS] Running system diagnosis...');
  
  // Get current system health for context
  const health = await runHealthCheck();
  
  // Create the ARCANOS prompt
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

  // Use GPT-4.1 for diagnostic capabilities
  const response = await createResponseWithLogging(client, {
    model: 'gpt-4.1-mini',
    input: [
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
    max_output_tokens: 2000,
    stream: false,
  });

  const fullResult = response.output_text || '';
  
  // Parse the structured response
  const componentStatusMatch = fullResult.match(/✅ Component Status Table\s*([\s\S]*?)(?=🛠|$)/);
  const suggestedFixesMatch = fullResult.match(/🛠 Suggested Fixes\s*([\s\S]*?)(?=🧠|$)/);
  const coreLogicTraceMatch = fullResult.match(/🧠 Core Logic Trace\s*([\s\S]*?)$/);
  
  const componentStatus = componentStatusMatch ? componentStatusMatch[1].trim() : 'Status information not available';
  const suggestedFixes = suggestedFixesMatch ? suggestedFixesMatch[1].trim() : 'No fixes suggested';
  const coreLogicTrace = coreLogicTraceMatch ? coreLogicTraceMatch[1].trim() : 'Logic trace not available';

  console.log('[🔬 ARCANOS] Diagnosis complete');

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