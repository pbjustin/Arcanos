import OpenAI from 'openai';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';

let openai: OpenAI | null = null;
let defaultModel: string | null = null;
const API_TIMEOUT_MS = parseInt(process.env.WORKER_API_TIMEOUT_MS || '30000', 10);

/**
 * Generates mock AI responses when OpenAI API key is not available
 * 
 * @param input - User input text to generate a mock response for
 * @param endpoint - API endpoint name (ask, write, guide, audit, sim, etc.)
 * @returns Mock response object with realistic structure matching real AI responses
 */
export const generateMockResponse = (input: string, endpoint: string = 'ask'): any => {
  const mockId = `mock_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  const timestamp = Math.floor(Date.now() / 1000);
  
  const baseMockResponse = {
    meta: {
      id: mockId,
      created: timestamp,
      tokens: {
        prompt_tokens: 50,
        completion_tokens: 100,
        total_tokens: 150
      }
    },
    activeModel: 'MOCK',
    fallbackFlag: false,
    gpt5Used: true,
    routingStages: ['ARCANOS-INTAKE:MOCK', 'GPT5-REASONING', 'ARCANOS-FINAL'],
    auditSafe: {
      mode: true,
      overrideUsed: input.toLowerCase().includes('override'),
      overrideReason: input.toLowerCase().includes('override') ? 'Mock override detected in input' : undefined,
      auditFlags: ['MOCK_MODE', 'AUDIT_SAFE_ACTIVE'],
      processedSafely: true
    },
    memoryContext: {
      entriesAccessed: Math.floor(Math.random() * 3),
      contextSummary: 'Mock memory context - no real memory system active',
      memoryEnhanced: Math.random() > 0.5
    },
    taskLineage: {
      requestId: mockId,
      logged: true
    },
    error: 'OPENAI_API_KEY not configured - returning mock response'
  };

  switch (endpoint) {
    case 'arcanos':
      return {
        ...baseMockResponse,
        result: `[MOCK ARCANOS RESPONSE] System analysis for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        componentStatus: 'MOCK: All systems simulated as operational',
        suggestedFixes: 'MOCK: Configure OPENAI_API_KEY for real analysis',
        coreLogicTrace: 'MOCK: Trinity -> ARCANOS -> Mock Response Generator',
        gpt5Delegation: {
          used: true,
          reason: 'Unconditional GPT-5 routing (mock)',
          delegatedQuery: input
        }
      };
    case 'ask':
    case 'brain':
      return {
        ...baseMockResponse,
        result: `[MOCK AI RESPONSE] Processed request: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockBrain'
      };
    case 'write':
      return {
        ...baseMockResponse,
        result: `[MOCK WRITE RESPONSE] Generated content for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockWriter',
        endpoint: 'write'
      };
    case 'guide':
      return {
        ...baseMockResponse,
        result: `[MOCK GUIDE RESPONSE] Step-by-step guidance for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockGuide',
        endpoint: 'guide'
      };
    case 'audit':
      return {
        ...baseMockResponse,
        result: `[MOCK AUDIT RESPONSE] Analysis and evaluation of: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockAuditor',
        endpoint: 'audit'
      };
    case 'sim':
      return {
        ...baseMockResponse,
        result: `[MOCK SIMULATION RESPONSE] Scenario modeling for: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockSimulator',
        endpoint: 'sim'
      };
    default:
      return {
        ...baseMockResponse,
        result: `[MOCK RESPONSE] Processed request: "${input.substring(0, 50)}${input.length > 50 ? '...' : ''}"`,
        module: 'MockProcessor'
      };
  }
};

/**
 * Validates whether a proper OpenAI API key is configured
 * 
 * @returns True if API key is set and valid, false otherwise
 */
export const hasValidAPIKey = (): boolean => {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  return !!(apiKey && apiKey.trim() !== '' && apiKey !== 'your-openai-api-key-here' && apiKey !== 'your-openai-key-here');
};

/**
 * Initializes OpenAI client with API key validation and default model configuration
 * 
 * @returns OpenAI client instance or null if initialization fails
 */
const initializeOpenAI = (): OpenAI | null => {
  if (openai) return openai;

  try {
    const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
    if (!hasValidAPIKey()) {
      console.warn('⚠️ OPENAI_API_KEY not configured - AI endpoints will return mock responses');
      return null; // Return null to indicate mock mode
    }

    openai = new OpenAI({ apiKey, timeout: API_TIMEOUT_MS });
    defaultModel = process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:arcanos-v1-1106';
    
    console.log('✅ OpenAI client initialized');
    console.log(`🧠 Default AI Model: ${defaultModel}`);
    console.log(`🔄 Fallback Model: gpt-4`);
    
    return openai;
  } catch (error) {
    console.error('❌ Failed to initialize OpenAI client:', error);
    return null;
  }
};

/**
 * Gets the active OpenAI client instance, initializing if needed
 * 
 * @returns OpenAI client instance or null if unavailable
 */
export const getOpenAIClient = (): OpenAI | null => {
  return openai || initializeOpenAI();
};

/**
 * Gets the configured default AI model (typically fine-tuned)
 * 
 * @returns Model identifier string
 */
export const getDefaultModel = (): string => {
  return defaultModel || process.env.AI_MODEL || 'REDACTED_FINE_TUNED_MODEL_ID';
};

/**
 * Gets the configured GPT-5 model identifier
 * 
 * @returns GPT-5 model string (defaults to 'gpt-5')
 */
export const getGPT5Model = (): string => {
  return process.env.GPT5_MODEL || 'gpt-5';
};

/**
 * Gets the fallback model when primary model fails
 * 
 * @returns Fallback model identifier (always 'gpt-4')
 */
export const getFallbackModel = (): string => {
  return 'gpt-4';
};

/**
 * Unified OpenAI call helper with token parameter fallback
 */
export async function callOpenAI(
  model: string,
  prompt: string,
  tokenLimit: number
): Promise<{ response: any; output: string }> {
  const client = getOpenAIClient();
  if (!client) {
    const mock = generateMockResponse(prompt, 'ask');
    return { response: mock, output: mock.result };
  }

  const messages = [
    { role: 'system' as const, content: 'You are a helpful AI assistant.' },
    { role: 'user' as const, content: prompt }
  ];

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response: any = await Promise.race([
        client.chat.completions.create({
          model,
          messages,
          max_tokens: tokenLimit
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('OpenAI request timed out')), API_TIMEOUT_MS)
        )
      ]);

      const output = response.choices?.[0]?.message?.content || '';
      return { response, output };
    } catch (err: any) {
      const message = err?.message?.toLowerCase() || '';
      if (message.includes('max_tokens')) {
        const response = await client.chat.completions.create({
          model,
          messages,
          max_completion_tokens: tokenLimit
        });
        const output = response.choices?.[0]?.message?.content || '';
        return { response, output };
      }

      if (attempt < 3) {
        console.warn(`OpenAI call failed (attempt ${attempt}): ${err.message}`);
        continue;
      }

      throw err;
    }
  }

  // Should never reach here
  throw new Error('OpenAI call failed');
}

/**
 * Make a chat completion with automatic fallback to GPT-4 if fine-tuned model fails
 */
export const createChatCompletionWithFallback = async (
  client: OpenAI,
  params: any
): Promise<any> => {
  const primaryModel = getDefaultModel();
  const fallbackModel = getFallbackModel();
  
  try {
    // First attempt with the fine-tuned model
    console.log(`🧠 Attempting with primary model: ${primaryModel}`);
    const response = await client.chat.completions.create({
      ...params,
      model: primaryModel
    });
    
    return {
      ...response,
      activeModel: primaryModel,
      fallbackFlag: false
    };
  } catch (error) {
    console.warn(`⚠️ Primary model ${primaryModel} failed, falling back to ${fallbackModel}`);
    console.warn(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    
    try {
      // Fallback to GPT-4
      const fallbackResponse = await client.chat.completions.create({
        ...params,
        model: fallbackModel
      });
      
      return {
        ...fallbackResponse,
        activeModel: fallbackModel,
        fallbackFlag: true,
        fallbackReason: `Primary model ${primaryModel} failed: ${error instanceof Error ? error.message : 'Unknown error'}`
      };
    } catch (fallbackError) {
      console.error(`❌ Fallback model ${fallbackModel} also failed:`, fallbackError);
      throw fallbackError;
    }
  }
};

export const validateAPIKeyAtStartup = (): boolean => {
  const apiKey = process.env.API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.trim() === '' || apiKey === 'your-openai-api-key-here' || apiKey === 'your-openai-key-here') {
    console.warn('⚠️ OPENAI_API_KEY not set - will return mock responses');
    return true; // Allow startup but return mock responses
  }
  console.log('✅ OPENAI_API_KEY validation passed');
  return true;
};

/**
 * Centralized GPT-5 helper function for reasoning tasks
 * Used by both core logic and workers
 */
export const createGPT5Reasoning = async (
  client: OpenAI,
  prompt: string,
  systemPrompt?: string
): Promise<{ content: string; error?: string }> => {
  if (!client) {
    return { content: '[Fallback: GPT-5 unavailable - no OpenAI client]', error: 'No OpenAI client' };
  }

  try {
    const gpt5Model = getGPT5Model();
    console.log(`🚀 [GPT-5 REASONING] Using model: ${gpt5Model}`);
    
    // Use token parameter utility for correct parameter selection
    const tokenParams = getTokenParameter(gpt5Model, 1024);
    
    const response = await client.chat.completions.create({
      model: gpt5Model,
      messages: [
        ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
        { role: 'user' as const, content: prompt }
      ],
      ...tokenParams,
      // Temperature omitted to use default (1) for GPT-5
    });
    
    const content = response.choices[0]?.message?.content ?? '[No reasoning provided]';
    console.log(`✅ [GPT-5 REASONING] Success: ${content.substring(0, 100)}...`);
    return { content };
  } catch (err: any) {
    const errorMsg = err?.message || 'Unknown error';
    console.error(`❌ [GPT-5 REASONING] Error: ${errorMsg}`);
    return { content: `[Fallback: GPT-5 unavailable - ${errorMsg}]`, error: errorMsg };
  }
};

export default { getOpenAIClient, getDefaultModel, getGPT5Model, createGPT5Reasoning, validateAPIKeyAtStartup, callOpenAI };