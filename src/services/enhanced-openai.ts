/**
 * Enhanced OpenAI SDK Service - Modular, Secured, Token-Efficient
 * Designed for ARCANOS agent-control deployment mode
 */

import OpenAI from 'openai';
import type { ChatCompletionCreateParams, ChatCompletionMessageParam } from 'openai/resources';
import { config } from '../config';

// Security and rate limiting
interface SecurityLimits {
  maxTokensPerRequest: number;
  maxRequestsPerMinute: number;
  allowedModels: string[];
  requireApiKey: boolean;
}

interface TokenUsageTracker {
  totalTokens: number;
  requestCount: number;
  lastResetTime: number;
  windowMs: number;
}

// Enhanced configuration for agent-control mode
interface ArcanosOpenAIConfig {
  apiKey?: string;
  deployMode: 'agent-control' | 'standard';
  security: SecurityLimits;
  tokenOptimization: {
    enableCompression: boolean;
    maxContextLength: number;
    intelligentTruncation: boolean;
  };
  models: {
    primary: string;
    fallback: string;
    codeAnalysis: string;
  };
}

export class ArcanosOpenAIService {
  private client: OpenAI;
  private config: ArcanosOpenAIConfig;
  private tokenTracker: TokenUsageTracker;

  constructor() {
    this.config = this.initializeConfig();
    this.validateSecurityConfig();
    this.client = this.createSecureClient();
    this.tokenTracker = this.initializeTokenTracker();
    
    console.log('🤖 ARCANOS OpenAI Service initialized');
    console.log(`🔧 Deploy Mode: ${this.config.deployMode}`);
    console.log(`🔑 Security Level: ${this.config.security.requireApiKey ? 'HIGH' : 'STANDARD'}`);
    console.log(`💰 Token Optimization: ${this.config.tokenOptimization.enableCompression ? 'ENABLED' : 'DISABLED'}`);
  }

  private initializeConfig(): ArcanosOpenAIConfig {
    return {
      apiKey: process.env.OPENAI_API_KEY,
      deployMode: (process.env.DEPLOY_MODE as 'agent-control' | 'standard') || 'agent-control',
      security: {
        maxTokensPerRequest: parseInt(process.env.MAX_TOKENS_PER_REQUEST || '4000'),
        maxRequestsPerMinute: parseInt(process.env.MAX_REQUESTS_PER_MINUTE || '30'),
        allowedModels: (process.env.ALLOWED_MODELS || 'gpt-4,gpt-4-turbo,gpt-3.5-turbo').split(','),
        requireApiKey: process.env.REQUIRE_API_KEY !== 'false'
      },
      tokenOptimization: {
        enableCompression: process.env.ENABLE_TOKEN_COMPRESSION !== 'false',
        maxContextLength: parseInt(process.env.MAX_CONTEXT_LENGTH || '8000'),
        intelligentTruncation: process.env.INTELLIGENT_TRUNCATION !== 'false'
      },
      models: {
        primary: process.env.AI_MODEL || process.env.FINE_TUNE_MODEL || 'gpt-4-turbo',
        fallback: process.env.FALLBACK_MODEL || 'gpt-3.5-turbo',
        codeAnalysis: process.env.CODE_INTERPRETER_MODEL || 'gpt-4o'
      }
    };
  }

  private validateSecurityConfig(): void {
    if (this.config.deployMode === 'agent-control' && this.config.security.requireApiKey && !this.config.apiKey) {
      throw new Error('ARCANOS agent-control mode requires OPENAI_API_KEY');
    }

    if (this.config.security.maxTokensPerRequest > 16000) {
      console.warn('⚠️ High token limit detected - this may impact cost efficiency');
    }
  }

  private createSecureClient(): OpenAI {
    if (!this.config.apiKey) {
      throw new Error('OpenAI API key required for ARCANOS operation');
    }

    return new OpenAI({
      apiKey: this.config.apiKey,
      timeout: 30000,
      maxRetries: 3,
    });
  }

  private initializeTokenTracker(): TokenUsageTracker {
    return {
      totalTokens: 0,
      requestCount: 0,
      lastResetTime: Date.now(),
      windowMs: 60000 // 1 minute
    };
  }

  /**
   * Modular chat completion with security and optimization
   */
  async chat(
    prompt: string,
    context: 'code_analysis' | 'deployment_analysis' | 'release_analysis' | 'general' = 'general',
    options: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      useOptimization?: boolean;
    } = {}
  ): Promise<{
    response: string;
    model: string;
    tokensUsed: number;
    optimizationApplied: boolean;
  }> {
    // Rate limiting check
    this.checkRateLimits();

    // Model selection based on context
    const selectedModel = this.selectModelForContext(context, options.model);
    
    // Token optimization
    const optimizedPrompt = options.useOptimization !== false 
      ? this.optimizePrompt(prompt, context)
      : prompt;

    // Security validation
    this.validateRequest(selectedModel, options.maxTokens || 1000);

    try {
      const messages: ChatCompletionMessageParam[] = [
        {
          role: 'system',
          content: this.getSystemPromptForContext(context)
        },
        {
          role: 'user',
          content: optimizedPrompt
        }
      ];

      const completion = await this.client.chat.completions.create({
        model: selectedModel,
        messages,
        max_tokens: Math.min(
          options.maxTokens || 1000,
          this.config.security.maxTokensPerRequest
        ),
        temperature: options.temperature || 0.7,
      });

      const response = completion.choices[0]?.message?.content || '';
      const tokensUsed = completion.usage?.total_tokens || 0;

      // Update token tracking
      this.updateTokenUsage(tokensUsed);

      return {
        response,
        model: selectedModel,
        tokensUsed,
        optimizationApplied: options.useOptimization !== false
      };

    } catch (error: any) {
      console.error('[ARCANOS-OPENAI] Chat completion error:', error.message);
      throw new Error(`OpenAI request failed: ${error.message}`);
    }
  }

  /**
   * Specialized method for GitHub code analysis
   */
  async analyzeCode(
    codeContent: string,
    analysisType: 'security' | 'quality' | 'deployment' | 'performance'
  ): Promise<string> {
    const context = 'code_analysis';
    const model = this.config.models.codeAnalysis;

    const prompt = `Analyze the following code for ${analysisType}:

${codeContent}

Provide a detailed analysis focusing on ${analysisType} aspects.`;

    const result = await this.chat(prompt, context, { 
      model, 
      maxTokens: 2000, 
      temperature: 0.3 
    });

    return result.response;
  }

  /**
   * Token-efficient batch processing
   */
  async batchProcess(
    prompts: Array<{ prompt: string; context?: string }>,
    options: { maxConcurrent?: number } = {}
  ): Promise<Array<{ response: string; tokensUsed: number }>> {
    const maxConcurrent = options.maxConcurrent || 3;
    const results: Array<{ response: string; tokensUsed: number }> = [];

    // Process in batches to manage rate limits
    for (let i = 0; i < prompts.length; i += maxConcurrent) {
      const batch = prompts.slice(i, i + maxConcurrent);
      
      const batchPromises = batch.map(async ({ prompt, context }) => {
        const result = await this.chat(prompt, context as any);
        return { response: result.response, tokensUsed: result.tokensUsed };
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches
      if (i + maxConcurrent < prompts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    return results;
  }

  private selectModelForContext(
    context: string, 
    preferredModel?: string
  ): string {
    if (preferredModel && this.config.security.allowedModels.includes(preferredModel)) {
      return preferredModel;
    }

    switch (context) {
      case 'code_analysis':
        return this.config.models.codeAnalysis;
      case 'deployment_analysis':
      case 'release_analysis':
        return this.config.models.primary;
      default:
        return this.config.models.primary;
    }
  }

  private getSystemPromptForContext(context: string): string {
    const basePrompt = "You are ARCANOS, an AI backend controller with agent-control capabilities.";
    
    switch (context) {
      case 'code_analysis':
        return `${basePrompt} You specialize in code analysis, security review, and quality assessment. Provide detailed, actionable insights.`;
      case 'deployment_analysis':
        return `${basePrompt} You analyze deployment readiness, infrastructure requirements, and release safety. Be thorough and cautious.`;
      case 'release_analysis':
        return `${basePrompt} You evaluate releases, generate documentation, and assess impact. Focus on clarity and completeness.`;
      default:
        return `${basePrompt} You provide intelligent assistance for backend operations and GitHub integration.`;
    }
  }

  private optimizePrompt(prompt: string, context: string): string {
    if (!this.config.tokenOptimization.enableCompression) {
      return prompt;
    }

    // Basic prompt optimization
    let optimized = prompt.trim();
    
    // Remove excessive whitespace
    optimized = optimized.replace(/\s+/g, ' ');
    
    // Truncate if too long (intelligent truncation)
    if (this.config.tokenOptimization.intelligentTruncation) {
      const maxLength = this.config.tokenOptimization.maxContextLength;
      if (optimized.length > maxLength) {
        // Keep beginning and end, truncate middle
        const keepLength = Math.floor(maxLength * 0.4);
        const start = optimized.substring(0, keepLength);
        const end = optimized.substring(optimized.length - keepLength);
        optimized = `${start}\n... [content truncated for efficiency] ...\n${end}`;
      }
    }

    return optimized;
  }

  private checkRateLimits(): void {
    const now = Date.now();
    
    // Reset window if needed
    if (now - this.tokenTracker.lastResetTime > this.tokenTracker.windowMs) {
      this.tokenTracker.requestCount = 0;
      this.tokenTracker.lastResetTime = now;
    }

    // Check limits
    if (this.tokenTracker.requestCount >= this.config.security.maxRequestsPerMinute) {
      throw new Error('Rate limit exceeded - too many requests per minute');
    }
  }

  private validateRequest(model: string, maxTokens: number): void {
    if (!this.config.security.allowedModels.includes(model)) {
      throw new Error(`Model ${model} not in allowed list`);
    }

    if (maxTokens > this.config.security.maxTokensPerRequest) {
      throw new Error(`Token request ${maxTokens} exceeds limit ${this.config.security.maxTokensPerRequest}`);
    }
  }

  private updateTokenUsage(tokensUsed: number): void {
    this.tokenTracker.totalTokens += tokensUsed;
    this.tokenTracker.requestCount += 1;
  }

  /**
   * Get usage statistics
   */
  getUsageStats(): {
    totalTokens: number;
    requestCount: number;
    estimatedCost: number;
  } {
    // Rough cost estimation (varies by model)
    const avgCostPer1kTokens = 0.002; // Approximate
    const estimatedCost = (this.tokenTracker.totalTokens / 1000) * avgCostPer1kTokens;

    return {
      totalTokens: this.tokenTracker.totalTokens,
      requestCount: this.tokenTracker.requestCount,
      estimatedCost: parseFloat(estimatedCost.toFixed(4))
    };
  }
}

// Export singleton instance
export const arcanosOpenAI = new ArcanosOpenAIService();