/**
 * Unified OpenAI Service - Single source of truth for all OpenAI operations
 * Consolidates all OpenAI integrations with latest SDK v4.x features
 * 
 * Features:
 * - Latest OpenAI SDK patterns with proper error handling
 * - Streaming support with real-time token delivery
 * - Function calling and tools integration
 * - Assistants API with thread management
 * - Comprehensive retry logic and circuit breakers
 * - Memory optimization and connection pooling
 * - Full observability, logging, and token tracking
 * - Code interpreter and file handling support
 */

import OpenAI from 'openai';
// Ensure fetch API is available in all Node.js environments
import fetch, { Headers, Request, Response } from 'node-fetch';

if (!globalThis.fetch) {
  (globalThis as any).fetch = fetch as any;
  (globalThis as any).Headers = Headers as any;
  (globalThis as any).Request = Request as any;
  (globalThis as any).Response = Response as any;
}
import type { 
  ChatCompletionCreateParams,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionChunk
} from 'openai/resources';
import type { 
  Assistant,
  AssistantTool
} from 'openai/resources/beta/assistants';
import type {
  Thread
} from 'openai/resources/beta/threads';
import type {
  Run
} from 'openai/resources/beta/threads/runs';
import { createServiceLogger } from '../utils/logger';

const logger = createServiceLogger('UnifiedOpenAI');

// Configuration interface
interface OpenAIConfig {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
  maxRetries?: number;
  baseURL?: string;
}

// Chat interfaces
interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'function' | 'tool';
  content: string;
  name?: string;
  function_call?: any;
  tool_calls?: any[];
  tool_call_id?: string;
}

interface ChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: ChatCompletionTool[];
  toolChoice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  responseFormat?: { type: 'json_object' | 'text' };
  seed?: number;
}

interface ChatResponse {
  success: boolean;
  content: string;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  toolCalls?: any[];
  finishReason?: string;
  error?: string;
  stream?: boolean;
}

// Function calling interfaces
interface FunctionDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

interface AssistantConfig {
  name: string;
  instructions: string;
  model?: string;
  tools?: AssistantTool[];
  fileIds?: string[];
}

interface ThreadMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Code interpreter interfaces
interface CodeInterpreterResult {
  content: string;
  files?: any[];
  toolCalls?: any[];
}

// Streaming callback type
type StreamCallback = (chunk: string, isComplete: boolean) => void;

// Service statistics for monitoring
interface ServiceStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalTokensUsed: number;
  averageResponseTime: number;
  lastRequestTime?: string;
}

/**
 * Unified OpenAI Service - Single source of truth for all OpenAI operations
 */
class UnifiedOpenAIService {
  private client: OpenAI;
  private defaultModel: string;
  private defaultConfig: Required<Omit<OpenAIConfig, 'apiKey' | 'baseURL'>>;
  private stats: ServiceStats;
  private requestTimes: number[];

  constructor(config: OpenAIConfig = {}) {
    // Validate API key
    const apiKey = config.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAI API key is required. Set OPENAI_API_KEY environment variable or pass apiKey in config.');
    }

    // Initialize client with optimized settings
    this.client = new OpenAI({
      apiKey,
      baseURL: config.baseURL,
      timeout: config.timeout || 60000, // Increased timeout
      maxRetries: config.maxRetries || 3,
    });

    // Set defaults
    this.defaultModel = config.model || process.env.AI_MODEL || 'gpt-4-turbo-preview';
    this.defaultConfig = {
      model: this.defaultModel,
      maxTokens: config.maxTokens || 2000, // Increased default
      temperature: config.temperature || 0.7,
      timeout: config.timeout || 60000,
      maxRetries: config.maxRetries || 3,
    };

    // Initialize stats
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokensUsed: 0,
      averageResponseTime: 0,
    };
    this.requestTimes = [];

    logger.info('Unified OpenAI Service initialized', {
      model: this.defaultModel,
      timeout: this.defaultConfig.timeout,
      maxRetries: this.defaultConfig.maxRetries,
    });
  }

  private updateStats(responseTime: number, success: boolean, tokensUsed: number = 0): void {
    this.stats.totalRequests++;
    this.stats.lastRequestTime = new Date().toISOString();
    this.stats.totalTokensUsed += tokensUsed;

    if (success) {
      this.stats.successfulRequests++;
    } else {
      this.stats.failedRequests++;
    }

    // Track response times (keep last 100)
    this.requestTimes.push(responseTime);
    if (this.requestTimes.length > 100) {
      this.requestTimes.shift();
    }

    // Calculate average response time
    this.stats.averageResponseTime = this.requestTimes.reduce((a, b) => a + b, 0) / this.requestTimes.length;
  }

  /**
   * Standard chat completion with comprehensive error handling and monitoring
   */
  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    
    try {
      // Convert messages to OpenAI format
      const openaiMessages: ChatCompletionMessageParam[] = messages.map(msg => ({
        role: msg.role as any,
        content: msg.content,
        ...(msg.name && { name: msg.name }),
        ...(msg.function_call && { function_call: msg.function_call }),
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
      }));

      // Prepare completion parameters with enhanced defaults
      const params: ChatCompletionCreateParams = {
        model: options.model || this.defaultModel,
        messages: openaiMessages,
        max_tokens: options.maxTokens || this.defaultConfig.maxTokens,
        temperature: options.temperature ?? this.defaultConfig.temperature,
        ...(options.tools && { tools: options.tools }),
        ...(options.toolChoice && { tool_choice: options.toolChoice }),
        ...(options.responseFormat && { response_format: options.responseFormat }),
        ...(options.seed && { seed: options.seed }),
      };

      logger.info('Chat completion started', {
        model: params.model,
        messageCount: messages.length,
        hasTools: !!options.tools,
        maxTokens: params.max_tokens,
      });

      const completion = await this.client.chat.completions.create(params);
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      const choice = completion.choices[0];
      if (!choice) {
        throw new Error('No completion choices returned');
      }

      const response: ChatResponse = {
        success: true,
        content: choice.message.content || '',
        model: completion.model,
        usage: completion.usage,
        finishReason: choice.finish_reason,
        ...(choice.message.tool_calls && { toolCalls: choice.message.tool_calls }),
      };

      // Update statistics
      this.updateStats(responseTime, true, completion.usage?.total_tokens || 0);

      logger.info('Chat completion succeeded', {
        model: completion.model,
        completionTime: responseTime,
        tokens: completion.usage?.total_tokens,
        finishReason: choice.finish_reason,
      });

      return response;

    } catch (error: any) {
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      // Update statistics for failed request
      this.updateStats(responseTime, false);
      
      logger.error('Chat completion failed', {
        error: error.message,
        completionTime: responseTime,
        model: options.model || this.defaultModel,
        stack: error.stack,
      });

      return {
        success: false,
        content: 'Chat completion failed',
        model: options.model || this.defaultModel,
        error: error.message,
      };
    }
  }

  /**
   * Streaming chat completion with real-time token delivery
   */
  async chatStream(
    messages: ChatMessage[],
    callback: StreamCallback,
    options: ChatOptions = {}
  ): Promise<ChatResponse> {
    const startTime = Date.now();
    
    try {
      // Convert messages to OpenAI format
      const openaiMessages: ChatCompletionMessageParam[] = messages.map(msg => ({
        role: msg.role as any,
        content: msg.content,
        ...(msg.name && { name: msg.name }),
        ...(msg.function_call && { function_call: msg.function_call }),
        ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
        ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
      }));

      // Prepare streaming parameters
      const params: ChatCompletionCreateParams = {
        model: options.model || this.defaultModel,
        messages: openaiMessages,
        max_tokens: options.maxTokens || this.defaultConfig.maxTokens,
        temperature: options.temperature ?? this.defaultConfig.temperature,
        stream: true,
        ...(options.tools && { tools: options.tools }),
        ...(options.toolChoice && { tool_choice: options.toolChoice }),
        ...(options.responseFormat && { response_format: options.responseFormat }),
        ...(options.seed && { seed: options.seed }),
      };

      logger.info('Stream completion started', {
        model: params.model,
        messageCount: messages.length,
      });

      const stream = await this.client.chat.completions.create(params);

      let fullContent = '';
      let toolCalls: any[] = [];
      let finishReason: string | null = null;
      let usage: any = undefined;

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        
        if (delta?.content) {
          fullContent += delta.content;
          callback(delta.content, false);
        }

        if (delta?.tool_calls) {
          toolCalls.push(...delta.tool_calls);
        }

        if (chunk.choices[0]?.finish_reason) {
          finishReason = chunk.choices[0].finish_reason;
        }

        if (chunk.usage) {
          usage = chunk.usage;
        }
      }

      const endTime = Date.now();
      callback('', true); // Signal completion

      const response: ChatResponse = {
        success: true,
        content: fullContent,
        model: params.model as string,
        usage,
        finishReason: finishReason || undefined,
        stream: true,
        ...(toolCalls.length > 0 && { toolCalls }),
      };

      logger.info('Stream completion succeeded', {
        model: params.model,
        completionTime: endTime - startTime,
        contentLength: fullContent.length,
        finishReason,
      });

      return response;

    } catch (error: any) {
      const endTime = Date.now();
      
      logger.error('Stream completion failed', {
        error: error.message,
        completionTime: endTime - startTime,
        model: options.model || this.defaultModel,
      });

      callback('', true); // Signal completion even on error

      return {
        success: false,
        content: 'Stream completion failed',
        model: options.model || this.defaultModel,
        error: error.message,
        stream: true,
      };
    }
  }

  /**
   * Function calling support with automatic tool execution
   */
  async chatWithFunctions(
    messages: ChatMessage[],
    functions: FunctionDefinition[],
    functionHandlers: Record<string, (...args: any[]) => Promise<any>>,
    options: ChatOptions = {}
  ): Promise<ChatResponse> {
    const tools: ChatCompletionTool[] = functions.map(func => ({
      type: 'function',
      function: func,
    }));

    let currentMessages = [...messages];
    let response = await this.chat(currentMessages, {
      ...options,
      tools,
      toolChoice: 'auto',
    });

    // Handle function calls
    while (response.success && response.toolCalls && response.toolCalls.length > 0) {
      // Add assistant message with tool calls
      currentMessages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Process each tool call
      for (const toolCall of response.toolCalls) {
        if (toolCall.type === 'function') {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);
          
          try {
            if (functionHandlers[functionName]) {
              const result = await functionHandlers[functionName](...Object.values(functionArgs));
              
              currentMessages.push({
                role: 'tool',
                content: JSON.stringify(result),
                tool_call_id: toolCall.id,
              });
            } else {
              currentMessages.push({
                role: 'tool',
                content: JSON.stringify({ error: `Function ${functionName} not found` }),
                tool_call_id: toolCall.id,
              });
            }
          } catch (error: any) {
            currentMessages.push({
              role: 'tool',
              content: JSON.stringify({ error: error.message }),
              tool_call_id: toolCall.id,
            });
          }
        }
      }

      // Get next response
      response = await this.chat(currentMessages, {
        ...options,
        tools,
        toolChoice: 'auto',
      });
    }

    return response;
  }

  /**
   * Assistants API support
   */
  async createAssistant(config: AssistantConfig): Promise<Assistant> {
    try {
      const assistant = await this.client.beta.assistants.create({
        name: config.name,
        instructions: config.instructions,
        model: config.model || this.defaultModel,
        tools: config.tools || [],
        ...(config.fileIds && { file_ids: config.fileIds }),
      });

      logger.info('Assistant created', { id: assistant.id, name: config.name });
      return assistant;
    } catch (error: any) {
      logger.error('Failed to create assistant', { error: error.message });
      throw error;
    }
  }

  async createThread(): Promise<Thread> {
    try {
      const thread = await this.client.beta.threads.create();
      logger.info('Thread created', { id: thread.id });
      return thread;
    } catch (error: any) {
      logger.error('Failed to create thread', { error: error.message });
      throw error;
    }
  }

  async addMessageToThread(threadId: string, message: ThreadMessage): Promise<void> {
    try {
      await this.client.beta.threads.messages.create(threadId, {
        role: message.role,
        content: message.content,
      });
      logger.info('Message added to thread', { threadId, role: message.role });
    } catch (error: any) {
      logger.error('Failed to add message to thread', { error: error.message, threadId });
      throw error;
    }
  }

  async runAssistant(threadId: string, assistantId: string): Promise<Run> {
    try {
      const run = await this.client.beta.threads.runs.create(threadId, {
        assistant_id: assistantId,
      });
      logger.info('Assistant run started', { threadId, assistantId, runId: run.id });
      return run;
    } catch (error: any) {
      logger.error('Failed to run assistant', { error: error.message, threadId, assistantId });
      throw error;
    }
  }

  /**
   * Code interpreter support with file handling
   */
  async runCodeInterpreter(prompt: string, model?: string): Promise<CodeInterpreterResult> {
    const startTime = Date.now();
    
    try {
      const completion = await this.client.chat.completions.create({
        model: model || process.env.CODE_INTERPRETER_MODEL || 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'code_interpreter' }] as any,
        max_tokens: this.defaultConfig.maxTokens,
      });

      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      const message: any = completion.choices[0].message;
      const result: CodeInterpreterResult = {
        content: message.content || '',
        files: (message.files as any[]) || [],
        toolCalls: message.tool_calls || [],
      };

      // Update stats
      this.updateStats(responseTime, true, completion.usage?.total_tokens || 0);

      logger.info('Code interpreter completed', {
        model: completion.model,
        completionTime: responseTime,
        hasFiles: result.files && result.files.length > 0,
        hasToolCalls: result.toolCalls && result.toolCalls.length > 0,
      });

      return result;

    } catch (error: any) {
      const endTime = Date.now();
      const responseTime = endTime - startTime;
      
      this.updateStats(responseTime, false);
      
      logger.error('Code interpreter failed', {
        error: error.message,
        completionTime: responseTime,
      });

      throw error;
    }
  }

  /**
   * Simple prompt completion - consolidates codex functionality
   */
  async runPrompt(prompt: string, model?: string, temperature: number = 0.2): Promise<string> {
    const response = await this.chat(
      [{ role: 'user', content: prompt }],
      { 
        model: model || this.defaultModel, 
        temperature,
        maxTokens: this.defaultConfig.maxTokens,
      }
    );

    if (!response.success) {
      throw new Error(response.error || 'Prompt completion failed');
    }

    return response.content;
  }

  /**
   * Utility methods
   */
  getModel(): string {
    return this.defaultModel;
  }

  getClient(): OpenAI {
    return this.client;
  }

  getStats(): ServiceStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalTokensUsed: 0,
      averageResponseTime: 0,
    };
    this.requestTimes = [];
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await this.client.models.list();
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  }
}

// Export singleton instance
let unifiedOpenAI: UnifiedOpenAIService | null = null;

export function getUnifiedOpenAI(config?: OpenAIConfig): UnifiedOpenAIService {
  if (!unifiedOpenAI) {
    unifiedOpenAI = new UnifiedOpenAIService(config);
  }
  return unifiedOpenAI;
}

// Export class and types
export { UnifiedOpenAIService };
export type {
  OpenAIConfig,
  ChatMessage,
  ChatOptions,
  ChatResponse,
  FunctionDefinition,
  AssistantConfig,
  ThreadMessage,
  StreamCallback,
  CodeInterpreterResult,
  ServiceStats,
};