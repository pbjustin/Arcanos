// ARCANOS AI Dispatcher - Unified dispatch system that sends all requests to fine-tuned model
// Replaces static logic, conditionals, and routing trees with AI-controlled decision making

import { OpenAIService, ChatMessage } from './openai';

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
  private openaiService: OpenAIService;
  private model: string;

  constructor() {
    this.openaiService = new OpenAIService();
    this.model = process.env.FINE_TUNED_MODEL || process.env.OPENAI_FINE_TUNED_MODEL || 'ft:gpt-3.5-turbo-0125:personal:arcanos-v1-1106';
    console.log('🤖 AI Dispatcher initialized with model:', this.model);
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
      
      return {
        success: true,
        instructions,
        directResponse: this.extractDirectResponse(response.message)
      };

    } catch (error: any) {
      console.error('❌ AI Dispatcher error:', error);
      return {
        success: false,
        instructions: [],
        error: error.message
      };
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
      if (Array.isArray(parsed)) {
        return parsed;
      } else {
        return [parsed];
      }

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
    const response = await this.openaiService.chat([
      { role: 'user', content: query }
    ]);
    
    return response.error ? `Error: ${response.error}` : response.message;
  }
}

// Export singleton instance
export const aiDispatcher = new AIDispatcher();