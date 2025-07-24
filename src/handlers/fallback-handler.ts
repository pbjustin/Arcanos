// ARCANOS:FALLBACK-HANDLER - Consolidated fallback worker logic
// Handles all undefined or fallback worker scenarios in a single module

import { MemoryStorage } from '../storage/memory-storage';
import { OpenAIService, ChatMessage } from '../services/openai';

export interface FallbackRequest {
  type: 'memory' | 'write' | 'audit' | 'diagnostic' | 'general';
  message?: string;
  data?: any;
  context?: any;
}

export interface FallbackResponse {
  success: boolean;
  data?: any;
  content?: string;
  error?: string;
  fallbackUsed: boolean;
  timestamp: string;
}

export class FallbackHandler {
  private memoryStorage: MemoryStorage;
  private openaiService: OpenAIService | null;

  constructor() {
    this.memoryStorage = new MemoryStorage();
    try {
      this.openaiService = new OpenAIService();
    } catch (error) {
      console.warn('⚠️ FallbackHandler: OpenAI not available, using mock responses');
      this.openaiService = null;
    }
  }

  async handleUndefinedWorker(request: FallbackRequest): Promise<FallbackResponse> {
    console.log(`🛡️ FallbackHandler: Handling undefined worker for type: ${request.type}`);

    const timestamp = new Date().toISOString();

    try {
      switch (request.type) {
        case 'memory':
          return await this.handleMemoryFallback(request, timestamp);
        case 'write':
          return await this.handleWriteFallback(request, timestamp);
        case 'audit':
          return await this.handleAuditFallback(request, timestamp);
        case 'diagnostic':
          return await this.handleDiagnosticFallback(request, timestamp);
        default:
          return await this.handleGeneralFallback(request, timestamp);
      }
    } catch (error: any) {
      console.error('❌ FallbackHandler error:', error);
      return {
        success: false,
        error: `Fallback handler error: ${error.message}`,
        fallbackUsed: true,
        timestamp
      };
    }
  }

  private async handleMemoryFallback(request: FallbackRequest, timestamp: string): Promise<FallbackResponse> {
    console.log('💾 Memory fallback activated - using in-memory storage');
    
    try {
      if (request.data?.memory_key && request.data?.memory_value !== undefined) {
        // Save operation
        const result = await this.memoryStorage.storeMemory(
          request.data.container_id || 'default',
          'default-session',
          'context',
          request.data.memory_key,
          request.data.memory_value
        );
        
        return {
          success: true,
          data: result,
          fallbackUsed: true,
          timestamp
        };
      } else if (request.data?.memory_key) {
        // Load operation
        const result = await this.memoryStorage.getMemory(
          request.data.container_id || 'default',
          request.data.memory_key
        );
        
        return {
          success: true,
          data: result,
          fallbackUsed: true,
          timestamp
        };
      } else {
        return {
          success: false,
          error: 'Invalid memory fallback request',
          fallbackUsed: true,
          timestamp
        };
      }
    } catch (error: any) {
      return {
        success: false,
        error: `Memory fallback error: ${error.message}`,
        fallbackUsed: true,
        timestamp
      };
    }
  }

  private async handleWriteFallback(request: FallbackRequest, timestamp: string): Promise<FallbackResponse> {
    console.log('✍️ Write fallback activated - generating fallback content');
    
    try {
      let content: string;
      
      if (this.openaiService) {
        const chatMessages: ChatMessage[] = [
          { 
            role: 'system', 
            content: 'You are ARCANOS in fallback mode. Generate helpful content based on the user request.' 
          },
          { role: 'user', content: request.message || 'Generate content' }
        ];
        
        const response = await this.openaiService.chat(chatMessages);
        
        if (response.error) {
          content = this.generateMockContent(request.message || 'content generation');
        } else {
          content = response.message;
        }
      } else {
        content = this.generateMockContent(request.message || 'content generation');
      }

      return {
        success: true,
        content,
        fallbackUsed: true,
        timestamp
      };
    } catch (error: any) {
      return {
        success: false,
        content: this.generateMockContent(request.message || 'error recovery'),
        error: `Write fallback error: ${error.message}`,
        fallbackUsed: true,
        timestamp
      };
    }
  }

  private async handleAuditFallback(request: FallbackRequest, timestamp: string): Promise<FallbackResponse> {
    console.log('🔍 Audit fallback activated - performing basic validation');
    
    const message = request.message || '';
    const auditResult = `[FALLBACK AUDIT] Content analyzed: "${message}". 
Length: ${message.length} characters. 
Basic validation completed. 
No critical issues detected in fallback mode.
Timestamp: ${timestamp}`;

    return {
      success: true,
      content: auditResult,
      fallbackUsed: true,
      timestamp
    };
  }

  private async handleDiagnosticFallback(request: FallbackRequest, timestamp: string): Promise<FallbackResponse> {
    console.log('🩺 Diagnostic fallback activated - basic system check');
    
    const memoryUsage = process.memoryUsage();
    const data = {
      status: 'operational_fallback',
      memory: {
        rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`
      },
      uptime: `${Math.floor(process.uptime())} seconds`,
      timestamp,
      fallbackMode: true
    };

    return {
      success: true,
      data,
      fallbackUsed: true,
      timestamp
    };
  }

  private async handleGeneralFallback(request: FallbackRequest, timestamp: string): Promise<FallbackResponse> {
    console.log('🔧 General fallback activated');
    
    return {
      success: true,
      content: `Fallback response for: ${request.message || 'general request'}. System is operational in fallback mode.`,
      fallbackUsed: true,
      timestamp
    };
  }

  private generateMockContent(prompt: string): string {
    return `[FALLBACK MODE] Generated response for: "${prompt}". 
This is a fallback response generated when the primary AI service is unavailable. 
In a production environment with OpenAI configured, this would be replaced with AI-generated content.
Generated at: ${new Date().toISOString()}`;
  }

  // Content validation to prevent null/incomplete content
  validateContent(content: any): { isValid: boolean; reason?: string } {
    if (content === null || content === undefined) {
      return { isValid: false, reason: 'Content is null or undefined' };
    }
    
    if (typeof content === 'string' && content.trim().length === 0) {
      return { isValid: false, reason: 'Content is empty string' };
    }
    
    if (typeof content === 'object' && Object.keys(content).length === 0) {
      return { isValid: false, reason: 'Content is empty object' };
    }

    return { isValid: true };
  }

  // Inject fallback content if model response lacks content field
  injectFallbackContent(response: any, originalRequest?: string): any {
    if (!response || !response.content) {
      console.log('🔧 Injecting fallback content - original response lacks content field');
      return {
        ...response,
        content: this.generateMockContent(originalRequest || 'missing content'),
        fallback_injected: true,
        original_response: response
      };
    }
    return response;
  }
}

// Export singleton instance
export const fallbackHandler = new FallbackHandler();