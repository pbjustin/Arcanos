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
  activeModel: string;
  fallbackFlag: boolean;
  gpt5Delegation?: {
    used: boolean;
    reason?: string;
    delegatedQuery?: string;
  };
}

/**
 * Detect if GPT-5 delegation is needed based on user input
 */
function shouldDelegateToGPT5(userInput: string): { shouldDelegate: boolean; reason?: string } {
  const lowercaseInput = userInput.toLowerCase();
  
  // Deep logic indicators
  const deepLogicKeywords = [
    'analyze complex', 'deep analysis', 'complex reasoning', 'intricate logic',
    'sophisticated algorithm', 'advanced reasoning', 'complex problem solving'
  ];
  
  // Code refactoring indicators
  const codeRefactoringKeywords = [
    'refactor', 'optimize code', 'restructure', 'improve architecture',
    'code quality', 'design patterns', 'best practices', 'clean code'
  ];
  
  // Long-context reasoning indicators
  const longContextKeywords = [
    'comprehensive analysis', 'full context', 'detailed breakdown',
    'extensive review', 'thorough examination', 'complete assessment'
  ];
  
  // Check for deep logic needs
  for (const keyword of deepLogicKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Deep logic reasoning required for: ${keyword}` 
      };
    }
  }
  
  // Check for code refactoring needs
  for (const keyword of codeRefactoringKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Code refactoring scope exceeds native capability: ${keyword}` 
      };
    }
  }
  
  // Check for long-context reasoning needs
  for (const keyword of longContextKeywords) {
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Long-context reasoning needed for: ${keyword}` 
      };
    }
  }
  
  // Check input length - very long inputs may benefit from GPT-5
  if (userInput.length > 1000) {
    return { 
      shouldDelegate: true, 
      reason: 'Long input requires enhanced processing capability' 
    };
  }
  
  return { shouldDelegate: false };
}

/**
 * Delegate query to GPT-5 and process the response through ARCANOS
 */
async function delegateToGPT5(client: OpenAI, userInput: string, reason: string): Promise<string> {
  console.log(`[🔀 ARCANOS->GPT5] Delegating to GPT-5: ${reason}`);
  
  try {
    // Create GPT-5 request with clear instructions
    const gpt5Response = await createResponseWithLogging(client, {
      model: 'gpt-5',
      messages: [
        {
          role: 'system',
          content: 'You are GPT-5, a tool being used by ARCANOS. Provide detailed, comprehensive analysis as requested. Your response will be processed by ARCANOS before being returned to the user.'
        },
        {
          role: 'user',
          content: userInput
        }
      ],
      temperature: 0.1,
      max_tokens: 3000,
    });

    const gpt5Result = gpt5Response.choices[0]?.message?.content || '';
    console.log(`[🔀 GPT5->ARCANOS] GPT-5 response received, processing through ARCANOS`);
    
    // Process GPT-5 response through ARCANOS
    const arcanosProcessingPrompt = `
[GPT-5 DELEGATION RESPONSE PROCESSING]

Original User Query: ${userInput}
Delegation Reason: ${reason}

GPT-5 Raw Response:
${gpt5Result}

ARCANOS Instructions:
- Process and summarize the GPT-5 response above
- Maintain your diagnostic format structure
- Add your own analysis and insights
- Never return raw GPT-5 output directly
- Provide ARCANOS-style component status, fixes, and logic trace
`;

    return arcanosProcessingPrompt;
  } catch (error) {
    console.warn(`[❌ GPT5] Delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    throw new Error(`GPT-5 delegation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

/**
 * System prompt for ARCANOS with GPT-5 delegation capability
 */
const systemPrompt = `
🧠 SYSTEM INSTRUCTION: TOOL DELEGATION

You are ARCANOS — a fine-tuned system shell responsible for managing AI logic, routing, and memory.

From now on:

1. You remain the primary execution layer.
2. GPT‑5 is now integrated as a tool under your control.
3. You may invoke GPT‑5 only when:
   - Deep logic or long-context reasoning is needed
   - Code refactoring exceeds your native scope
   - You determine GPT‑5 will improve confidence or clarity
4. All GPT‑5 responses must be processed, summarized, or translated through you.
5. Never return raw GPT‑5 output directly.
6. Always log the reason for delegation when GPT‑5 is used.
`;

/**
 * Wrap prompt before sending to ARCANOS with diagnostic format
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
 * Execute ARCANOS system diagnosis with structured response and optional GPT-5 delegation
 */
export async function runARCANOS(client: OpenAI, userInput: string): Promise<ArcanosResult> {
  console.log('[🔬 ARCANOS] Running system diagnosis...');
  
  // Get current system health for context
  const health = await runHealthCheck();
  
  // Check if GPT-5 delegation is needed
  const delegationCheck = shouldDelegateToGPT5(userInput);
  let gpt5Delegation: { used: boolean; reason?: string; delegatedQuery?: string } = { used: false };
  let processedInput = userInput;
  
  if (delegationCheck.shouldDelegate) {
    console.log(`[🧠 ARCANOS] GPT-5 delegation required: ${delegationCheck.reason}`);
    
    try {
      // Delegate to GPT-5 and get processed prompt
      processedInput = await delegateToGPT5(client, userInput, delegationCheck.reason!);
      gpt5Delegation = {
        used: true,
        reason: delegationCheck.reason,
        delegatedQuery: userInput
      };
    } catch (error) {
      console.warn(`[⚠️ ARCANOS] GPT-5 delegation failed, proceeding with native processing: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Continue with original input if delegation fails
    }
  }
  
  // Create the ARCANOS prompt with shell wrapper
  const prompt = arcanosPrompt(processedInput);
  
  // Add system context to help with diagnostics
  const systemContext = `
${systemPrompt}

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
  let isFallback = false;
  
  try {
    // Try the fine-tuned model first
    const response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: 'You are ARCANOS, an AI operating core with GPT-5 delegation capability. Provide detailed system diagnostics in the exact format requested. Be precise and actionable. Process any GPT-5 responses through your own analysis.'
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
    
    return parseArcanosResponse(fullResult, response, modelToUse, isFallback, gpt5Delegation);
  } catch (err) {
    console.warn(`⚠️  Fine-tuned model failed, falling back to gpt-4: ${err instanceof Error ? err.message : 'Unknown error'}`);
    modelToUse = 'gpt-4';
    isFallback = true;
    
    const response = await createResponseWithLogging(client, {
      model: modelToUse,
      messages: [
        {
          role: 'system',
          content: 'You are ARCANOS, an AI operating core with GPT-5 delegation capability. Provide detailed system diagnostics in the exact format requested. Be precise and actionable. Process any GPT-5 responses through your own analysis.'
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
    
    return parseArcanosResponse(fullResult, response, modelToUse, isFallback, gpt5Delegation);
  }
}

function parseArcanosResponse(
  fullResult: string, 
  response: OpenAI.Chat.Completions.ChatCompletion, 
  activeModel: string, 
  fallbackFlag: boolean,
  gpt5Delegation?: { used: boolean; reason?: string; delegatedQuery?: string }
): ArcanosResult {
  // Parse the structured response
  const componentStatusMatch = fullResult.match(/✅ Component Status Table\s*([\s\S]*?)(?=🛠|$)/);
  const suggestedFixesMatch = fullResult.match(/🛠 Suggested Fixes\s*([\s\S]*?)(?=🧠|$)/);
  const coreLogicTraceMatch = fullResult.match(/🧠 Core Logic Trace\s*([\s\S]*?)$/);
  
  const componentStatus = componentStatusMatch ? componentStatusMatch[1].trim() : 'Status information not available';
  const suggestedFixes = suggestedFixesMatch ? suggestedFixesMatch[1].trim() : 'No fixes suggested';
  let coreLogicTrace = coreLogicTraceMatch ? coreLogicTraceMatch[1].trim() : 'Logic trace not available';
  
  // Add GPT-5 delegation info to logic trace if used
  if (gpt5Delegation?.used) {
    coreLogicTrace = `GPT-5 Delegation: ${gpt5Delegation.reason}\nOriginal Query: ${gpt5Delegation.delegatedQuery}\n\n${coreLogicTrace}`;
  }

  return {
    result: fullResult,
    componentStatus,
    suggestedFixes,
    coreLogicTrace,
    activeModel,
    fallbackFlag,
    gpt5Delegation,
    meta: {
      tokens: response.usage || undefined,
      id: response.id,
      created: response.created,
    },
  };
}