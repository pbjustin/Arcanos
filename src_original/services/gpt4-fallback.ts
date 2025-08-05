/**
 * GPT-4 Fallback Service for ARCANOS
 * Recovers malformed or incomplete task results using GPT-4 reprocessing
 * 
 * Use case: When ARCANOS returns broken memory or logic output, 
 * hand off to GPT-4 for reprocessing into valid JSON or structured markdown
 */

import { getUnifiedOpenAI } from './unified-openai.js';
import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('GPT4Fallback');

export interface FallbackOptions {
  task: string;
  malformedOutput: string;
  expectedFormat?: 'json' | 'markdown' | 'text';
  maxTokens?: number;
  temperature?: number;
}

export interface FallbackResult {
  success: boolean;
  repairedOutput: string;
  originalOutput: string;
  fallbackApplied: boolean;
  error?: string;
  tokensUsed?: number;
}

/**
 * Detection patterns for common malformed outputs
 */
export const MALFORMED_PATTERNS = {
  // Incomplete JSON patterns
  incompleteJson: [
    /\{[^}]*$/,              // JSON object that doesn't close
    /\[[^\]]*$/,             // JSON array that doesn't close
    /^[^{[].*[^}\]]$/,       // Text that should be JSON but isn't wrapped
    /"[^"]*$/,               // Unterminated string
  ],
  
  // Incomplete markdown patterns
  incompleteMarkdown: [
    /```[^`]*$/,             // Code block that doesn't close
    /#{1,6}\s*$/,            // Heading without content
    /\|[^|]*$/,              // Table row that doesn't complete
    /^[-*+]\s*$/,            // List item without content
  ],
  
  // General patterns
  truncated: [
    /\.\.\.\s*$/,            // Text ending with ellipsis
    /\s*[A-Za-z]+\s*$/,      // Text that cuts off mid-word
    /^\s*$/,                 // Empty or whitespace-only output
  ],
  
  // Specific guide patterns
  incompleteGuide: [
    /^Chapter\s+\d+[^:]*$/,  // Chapter header without content
    /^Step\s+\d+[^:]*$/,     // Step header without content
    /^##?\s*[^#\n]*$/,       // Markdown header without following content
  ]
};

/**
 * GPT-4 Fallback Service
 */
class GPT4FallbackService {
  private openai: ReturnType<typeof getUnifiedOpenAI>;

  constructor() {
    this.openai = getUnifiedOpenAI();
    logger.info('GPT-4 Fallback Service initialized');
  }

  /**
   * Detect if output appears malformed based on common patterns
   */
  public detectMalformed(output: string, expectedFormat?: string): {
    isMalformed: boolean;
    detectedIssues: string[];
    confidence: number;
  } {
    const issues: string[] = [];
    let totalChecks = 0;
    let issueCount = 0;

    // Check for incomplete JSON
    if (expectedFormat === 'json' || this.looksLikeJson(output)) {
      totalChecks += MALFORMED_PATTERNS.incompleteJson.length;
      for (const pattern of MALFORMED_PATTERNS.incompleteJson) {
        if (pattern.test(output)) {
          issues.push('Incomplete JSON structure');
          issueCount++;
          break; // Don't double-count JSON issues
        }
      }
    }

    // Check for incomplete markdown
    if (expectedFormat === 'markdown' || this.looksLikeMarkdown(output)) {
      totalChecks += MALFORMED_PATTERNS.incompleteMarkdown.length;
      for (const pattern of MALFORMED_PATTERNS.incompleteMarkdown) {
        if (pattern.test(output)) {
          issues.push('Incomplete markdown structure');
          issueCount++;
          break; // Don't double-count markdown issues
        }
      }
    }

    // Check for general truncation
    totalChecks += MALFORMED_PATTERNS.truncated.length;
    for (const pattern of MALFORMED_PATTERNS.truncated) {
      if (pattern.test(output)) {
        issues.push('Output appears truncated');
        issueCount++;
        break;
      }
    }

    // Check for incomplete guide patterns
    totalChecks += MALFORMED_PATTERNS.incompleteGuide.length;
    for (const pattern of MALFORMED_PATTERNS.incompleteGuide) {
      if (pattern.test(output)) {
        issues.push('Incomplete guide structure');
        issueCount++;
        break;
      }
    }

    // Specific checks for common malformed patterns
    if (output.includes('[') && !output.includes(']')) {
      issues.push('Unmatched square brackets');
      issueCount++;
    }

    if (output.includes('{') && !output.includes('}')) {
      issues.push('Unmatched curly braces');
      issueCount++;
    }

    // Calculate confidence based on issue ratio
    const confidence = totalChecks > 0 ? (issueCount / Math.max(totalChecks, 6)) : 0;

    return {
      isMalformed: issues.length > 0,
      detectedIssues: issues,
      confidence: Math.min(confidence, 1.0)
    };
  }

  /**
   * Attempt to recover malformed output using GPT-4
   */
  public async fallbackToGPT4(options: FallbackOptions): Promise<FallbackResult> {
    const startTime = Date.now();
    
    try {
      logger.info('Attempting GPT-4 fallback recovery', {
        task: options.task,
        outputLength: options.malformedOutput.length,
        expectedFormat: options.expectedFormat
      });

      // Detect what's wrong with the output
      const detection = this.detectMalformed(options.malformedOutput, options.expectedFormat);
      
      if (!detection.isMalformed) {
        // Output doesn't appear malformed, return as-is
        return {
          success: true,
          repairedOutput: options.malformedOutput,
          originalOutput: options.malformedOutput,
          fallbackApplied: false
        };
      }

      // Prepare GPT-4 recovery prompt
      const systemPrompt = this.buildSystemPrompt(options.expectedFormat, detection.detectedIssues);
      const userPrompt = this.buildUserPrompt(options.task, options.malformedOutput, detection.detectedIssues);

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userPrompt }
      ];

      // Use GPT-4 for recovery
      const response = await this.openai.chat(messages, {
        model: 'gpt-4',
        temperature: options.temperature || 0.3,
        maxTokens: options.maxTokens || 2000,
        responseFormat: options.expectedFormat === 'json' ? { type: 'json_object' } : undefined
      });

      if (!response.success) {
        throw new Error(response.error || 'GPT-4 fallback request failed');
      }

      const repairedOutput = response.content.trim();

      // Validate the repaired output
      const repairedDetection = this.detectMalformed(repairedOutput, options.expectedFormat);
      
      const result: FallbackResult = {
        success: true,
        repairedOutput,
        originalOutput: options.malformedOutput,
        fallbackApplied: true,
        tokensUsed: response.usage?.total_tokens
      };

      const endTime = Date.now();
      logger.info('GPT-4 fallback recovery completed', {
        task: options.task,
        recoveryTime: endTime - startTime,
        originalIssues: detection.detectedIssues.length,
        repairedIssues: repairedDetection.detectedIssues.length,
        tokensUsed: response.usage?.total_tokens
      });

      return result;

    } catch (error: any) {
      const endTime = Date.now();
      
      logger.error('GPT-4 fallback recovery failed', {
        task: options.task,
        error: error.message,
        recoveryTime: endTime - startTime
      });

      return {
        success: false,
        repairedOutput: options.malformedOutput, // Return original on failure
        originalOutput: options.malformedOutput,
        fallbackApplied: false,
        error: error.message
      };
    }
  }

  /**
   * Quick check if output needs fallback processing
   */
  public needsFallback(output: string, expectedFormat?: string): boolean {
    const detection = this.detectMalformed(output, expectedFormat);
    return detection.isMalformed && detection.confidence > 0.3;
  }

  /**
   * Convenience method for common use case in the problem statement
   */
  public async recoverMalformedGuide(task: string, malformedOutput: string): Promise<string> {
    const result = await this.fallbackToGPT4({
      task,
      malformedOutput,
      expectedFormat: 'markdown',
      maxTokens: 3000,
      temperature: 0.3
    });

    return result.repairedOutput;
  }

  private buildSystemPrompt(expectedFormat?: string, detectedIssues?: string[]): string {
    let prompt = "You are a backend fixer that cleans up and normalizes memory or output data. ";
    
    if (expectedFormat === 'json') {
      prompt += "Your task is to fix malformed JSON data and return valid, well-structured JSON. ";
    } else if (expectedFormat === 'markdown') {
      prompt += "Your task is to fix malformed markdown content and return valid, well-structured markdown. ";
    } else {
      prompt += "Your task is to fix malformed text content and return clean, structured output. ";
    }

    if (detectedIssues && detectedIssues.length > 0) {
      prompt += `The following issues were detected: ${detectedIssues.join(', ')}. `;
    }

    prompt += "Preserve all original information while fixing structural issues. ";
    prompt += "Do not add new content, only fix formatting and structure. ";
    prompt += "If the content appears to be a guide or instructions, maintain the logical flow and completeness.";

    return prompt;
  }

  private buildUserPrompt(task: string, malformedOutput: string, detectedIssues: string[]): string {
    let prompt = `The task "${task}" returned broken or incomplete output:\n\n`;
    prompt += `${malformedOutput}\n\n`;
    
    if (detectedIssues.length > 0) {
      prompt += `Detected issues: ${detectedIssues.join(', ')}\n\n`;
    }
    
    prompt += "Fix this into valid, well-structured output while preserving all original information.";
    
    return prompt;
  }

  private looksLikeJson(text: string): boolean {
    const trimmed = text.trim();
    return (trimmed.startsWith('{') || trimmed.startsWith('[')) ||
           trimmed.includes('"') && (trimmed.includes(':') || trimmed.includes(','));
  }

  private looksLikeMarkdown(text: string): boolean {
    return text.includes('#') || text.includes('*') || text.includes('```') ||
           text.includes('|') || text.includes('[') && text.includes('](');
  }
}

// Export singleton instance
let gpt4FallbackService: GPT4FallbackService | null = null;

export function getGPT4FallbackService(): GPT4FallbackService {
  if (!gpt4FallbackService) {
    gpt4FallbackService = new GPT4FallbackService();
  }
  return gpt4FallbackService;
}

// Export the service class and types
export { GPT4FallbackService };