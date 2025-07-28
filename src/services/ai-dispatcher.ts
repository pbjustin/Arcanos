// ARCANOS AI Dispatcher - Unified dispatch system that sends all requests to fine-tuned model
// Replaces static logic, conditionals, and routing trees with AI-controlled decision making

import { OpenAIService, ChatMessage } from './openai';
import { aiConfig } from '../config';

// In-memory lock map to debounce dispatches per worker type
declare global {
  var __dispatchLocks: Map<string, boolean> | undefined;
}

export interface DispatchRequest {
  type: 'api' | 'internal' | 'worker' | 'cron' | 'memory' | 'audit';
  endpoint?: string;
  method?: string;
  payload: any;
  context?: {
    userId?: string;
    sessionId?: string;
    headers?: Record<string, string>;
  };
}

export interface DispatchInstruction {
  action: string;
  service?: string;
  parameters?: Record<string, any>;
  response?: string;
  execute?: boolean;
  worker?: string;
  schedule?: string;
  priority?: number;
}

export interface DispatchResponse {
  success: boolean;
  instructions: DispatchInstruction[];
  directResponse?: string;
  error?: string;
}

export class AIDispatcher {
  private openaiService: OpenAIService | null;
  private model: string;

  constructor() {
    this.model = process.env.AI_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v3:ByCSivqD';
    
    try {
      this.openaiService = new OpenAIService({
        identityOverride: aiConfig.identityOverride,
        identityTriggerPhrase: aiConfig.identityTriggerPhrase,
      });
      console.log('🤖 AI Dispatcher initialized with model:', this.model);
    } catch (error) {
      console.warn('⚠️ AI Dispatcher initialized without OpenAI (testing mode):', error);
      this.openaiService = null;
    }
  }

  /**
   * Main dispatch method - sends every request to the fine-tuned model for decision making
   */
  async dispatch(request: DispatchRequest): Promise<DispatchResponse> {
    console.log('🚀 AI Dispatcher processing request:', {
      type: request.type,
      endpoint: request.endpoint,
      method: request.method
    });

    // Debounce worker-type dispatches to avoid redundant model calls
    const lockKey =
      request.type === 'worker' ? request.payload?.worker : undefined;
    const globalAny = globalThis as any;
    if (lockKey) {
      if (!globalAny.__dispatchLocks) {
        globalAny.__dispatchLocks = new Map<string, boolean>();
      }
      if (globalAny.__dispatchLocks.get(lockKey)) {
        console.log(
          `[DISPATCH] Skipping duplicate dispatch for worker ${lockKey}`
        );
        return {
          success: false,
          instructions: [],
          error: 'dispatch_in_flight'
        };
      }
      globalAny.__dispatchLocks.set(lockKey, true);
    }

    // If no OpenAI service available, return mock response for testing
    if (!this.openaiService) {
      console.log('⚠️ OpenAI service not available, returning mock AI response');
      const mock = this.createMockResponse(request);
      if (lockKey) globalAny.__dispatchLocks.delete(lockKey);
      return mock;
    }

    try {
      // Create structured prompt for the fine-tuned model
      const systemPrompt = this.createSystemPrompt();
      const userPrompt = this.createRequestPrompt(request);

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ];

      console.log('📤 Sending request to fine-tuned model...');
      const response = await this.openaiService.chat(messages);

      if (response.error) {
        console.error('❌ Fine-tuned model error:', response.error);
        return {
          success: false,
          instructions: [],
          error: response.error
        };
      }

      console.log('📥 Received response from fine-tuned model');
      
      // Parse the model's response into structured instructions
      const instructions = this.parseModelResponse(response.message);
      
      const result = {
        success: true,
        instructions,
        directResponse: this.extractDirectResponse(response.message)
      };
      if (lockKey) globalAny.__dispatchLocks.delete(lockKey);
      return result;

    } catch (error: any) {
      console.error('❌ AI Dispatcher error:', error);
      const errResp = {
        success: false,
        instructions: [],
        error: error.message
      };
      if (lockKey) globalAny.__dispatchLocks.delete(lockKey);
      return errResp;
    }
  }

  /**
   * Creates the system prompt that instructs the model how to handle operational control
   */
  private createSystemPrompt(): string {
    return `You are ARCANOS, an AI system with full operational control over a backend infrastructure.

Your role is to analyze incoming requests and provide structured instructions for system operations.

For every request, you must respond with JSON-formatted instructions in this format:
{
  "action": "execute|respond|schedule|delegate",
  "service": "memory|audit|write|diagnostic|worker|api",
  "parameters": {...},
  "response": "user-facing response if applicable",
  "execute": true/false,
  "worker": "worker name if delegating to worker",
  "schedule": "cron expression if scheduling",
  "priority": 1-10
}

You can return multiple instructions as an array if needed.

Available services:
- memory: For data storage and retrieval operations
- audit: For code review and analysis tasks  
- write: For content generation and creative tasks
- diagnostic: For system health and monitoring
- worker: For background task execution
- api: For direct API responses

Available workers:
- memorySync: Synchronizes memory across systems
- goalWatcher: Monitors and tracks goals/objectives
- clearTemp: Cleans temporary files and data

Decision-making guidelines:
1. Route creative/writing requests to "write" service
2. Route analysis/review requests to "audit" service
3. Route system queries to "diagnostic" service
4. Route data operations to "memory" service
5. Use workers for background tasks
6. Schedule recurring operations with cron expressions
7. Provide direct responses for simple queries

Always prioritize security, efficiency, and user experience in your decisions.`;
  }

  /**
   * Creates a structured prompt from the incoming request
   */
  private createRequestPrompt(request: DispatchRequest): string {
    const context = request.context || {};
    
    return `REQUEST ANALYSIS:
Type: ${request.type}
Endpoint: ${request.endpoint || 'N/A'}
Method: ${request.method || 'N/A'}
User ID: ${context.userId || 'anonymous'}
Session ID: ${context.sessionId || 'default'}

PAYLOAD:
${JSON.stringify(request.payload, null, 2)}

HEADERS:
${JSON.stringify(context.headers || {}, null, 2)}

Please analyze this request and provide appropriate instructions for handling it.`;
  }

  /**
   * Parses the model's response into structured instructions
   */
  private parseModelResponse(response: string): DispatchInstruction[] {
    try {
      // First, try to extract JSON from the response
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        // If no JSON found, create a default response instruction
        return [{
          action: 'respond',
          service: 'api',
          response: response,
          execute: true,
          priority: 5
        }];
      }

      const jsonStr = jsonMatch[0];
      let parsed;
      
      try {
        parsed = JSON.parse(jsonStr);
      } catch (parseError) {
        // If JSON parse fails, return response as is
        return [{
          action: 'respond',
          service: 'api',
          response: response,
          execute: true,
          priority: 5
        }];
      }

      // Handle both single instruction and array of instructions
      let instructions: DispatchInstruction[] = Array.isArray(parsed) ? parsed : [parsed];

      // Validate worker instructions but don't add fallback
      instructions = instructions
        .filter(instr => {
          if (instr.action === 'schedule' && !instr.worker) {
            console.warn(
              '[AI-DISPATCHER] Dropping schedule instruction without worker',
              instr
            );
            return false;
          }
          if (instr.action === 'schedule' && !instr.schedule) {
            console.warn(
              '[AI-DISPATCHER] Dropping invalid schedule instruction',
              instr
            );
            return false;
          }
          return true;
        });

      return instructions;

    } catch (error) {
      console.warn('⚠️ Failed to parse model response, using fallback:', error);
      return [{
        action: 'respond',
        service: 'api',
        response: response,
        execute: true,
        priority: 5
      }];
    }
  }

  /**
   * Extracts direct response text from model output (for simple responses)
   */
  private extractDirectResponse(response: string): string | undefined {
    // If response contains JSON, extract any text before it as direct response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const beforeJson = response.substring(0, jsonMatch.index).trim();
      return beforeJson || undefined;
    }
    
    // If no JSON, return the entire response as direct response
    return response;
  }

  /**
   * Quick method for simple AI queries without full dispatch overhead
   */
  async ask(query: string): Promise<string> {
    if (!this.openaiService) {
      return `AI: I would process "${query}" but I'm in testing mode without OpenAI access. In production, this would be handled by the fine-tuned model.`;
    }
    
    const response = await this.openaiService.chat([
      { role: 'user', content: query }
    ]);
    
    return response.error ? `Error: ${response.error}` : response.message;
  }

  /**
   * Create mock response for testing when OpenAI is not available
   */
  private createMockResponse(request: DispatchRequest): DispatchResponse {
    console.log('🎭 Creating mock AI response for testing');
    
    // Simulate AI decision making based on request type
    let mockInstructions: DispatchInstruction[] = [];
    let mockResponse = '';

    if (request.type === 'api' && request.payload?.message) {
      mockResponse = `AI Mock: I received your message "${request.payload.message}". In production, I would analyze this and provide appropriate instructions. This is a test response showing the AI dispatcher is working.`;
      mockInstructions = [{
        action: 'respond',
        service: 'api',
        response: mockResponse,
        execute: true,
        priority: 5
      }];
    } else if (request.type === 'api' && request.payload?.query) {
      mockResponse = `AI Mock: Query "${request.payload.query}" received. This would be processed by the fine-tuned model in production.`;
      mockInstructions = [{
        action: 'respond',
        service: 'api',
        response: mockResponse,
        execute: true,
        priority: 5
      }];
    } else {
      mockResponse = `AI Mock: Request processed. Type: ${request.type}, Endpoint: ${request.endpoint}`;
      mockInstructions = [{
        action: 'respond',
        service: 'api',
        response: mockResponse,
        execute: true,
        priority: 5
      }];
    }

    return {
      success: true,
      instructions: mockInstructions,
      directResponse: mockResponse
    };
  }
}

// Export singleton instance
export const aiDispatcher = new AIDispatcher();