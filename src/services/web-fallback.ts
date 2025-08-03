/**
 * Web Fallback Service for ARCANOS
 * Purpose: When ARCANOS or GPT-4 lacks internal data, fetch from the web and inject into GPT context
 * Dependencies: axios, OpenAI SDK (latest), optional HTML summary module
 */

import axios from "axios";
import { getUnifiedOpenAI } from './unified-openai.js';
import { createServiceLogger } from '../utils/logger.js';

const logger = createServiceLogger('WebFallback');

interface WebFallbackOptions {
  url: string;
  topic?: string;
  maxContentLength?: number;
  timeout?: number;
}

interface WebFallbackResult {
  success: boolean;
  content: string;
  error?: string;
  metadata?: {
    url: string;
    contentLength: number;
    processedAt: string;
    tokensUsed?: number;
  };
}

/**
 * Extract and clean HTML content to plain text summary
 * This is a lightweight HTML-to-summary extractor as mentioned in the problem statement
 */
async function extractSummaryFromHtml(html: string, topicHint: string = ""): Promise<string> {
  // Remove HTML tags and get plain text (crude but safe approach as specified)
  const plain = html.replace(/<[^>]+>/g, "").slice(0, 2000);
  
  // Add topic hint if provided
  return topicHint ? `[${topicHint}]\n${plain}` : plain;
}

/**
 * Web Fallback to GPT function - main implementation from problem statement
 */
export async function webFallbackToGPT({ url, topic }: { url: string; topic?: string }): Promise<string> {
  try {
    logger.info('Fetching web content for GPT fallback', { url, topic });

    // Fetch content with proper User-Agent as specified
    const res = await axios.get(url, {
      headers: { "User-Agent": "ARCANOS/1.0 (Web Intelligence Agent)" },
      timeout: 30000, // 30 second timeout
      maxContentLength: 1000000 // 1MB limit
    });

    // Extract summary from HTML
    const summary = await extractSummaryFromHtml(res.data, topic);

    // Get unified OpenAI client
    const openai = getUnifiedOpenAI();

    // Create chat completion as specified in problem statement
    const response = await openai.chat([
      { role: "system", content: "You are a summarizer and strategic AI." },
      { role: "user", content: `Given this info from the web, provide a tactical summary:\n\n${summary}` }
    ], {
      model: "gpt-4",
      temperature: 0.3,
      maxTokens: 1500
    });

    if (!response.success) {
      throw new Error(response.error || 'GPT-4 processing failed');
    }

    logger.info('Web fallback completed successfully', {
      url,
      topic,
      summaryLength: summary.length,
      responseLength: response.content.length,
      tokensUsed: response.usage?.total_tokens
    });

    return response.content;

  } catch (err: any) {
    logger.warning("🛑 GPT fallback failed:", { error: err.message, url, topic });
    return "⚠️ Could not retrieve or summarize external content.";
  }
}

/**
 * Web Fallback Service Class - provides additional functionality beyond the basic function
 */
class WebFallbackService {
  private openai: ReturnType<typeof getUnifiedOpenAI>;

  constructor() {
    this.openai = getUnifiedOpenAI();
    logger.info('Web Fallback Service initialized');
  }

  /**
   * Enhanced web fallback with more configuration options
   */
  async fetchAndSummarize(options: WebFallbackOptions): Promise<WebFallbackResult> {
    const startTime = Date.now();

    try {
      logger.info('Enhanced web fallback request', options);

      // Fetch content with configurable options
      const res = await axios.get(options.url, {
        headers: { "User-Agent": "ARCANOS/1.0 (Web Intelligence Agent)" },
        timeout: options.timeout || 30000,
        maxContentLength: options.maxContentLength || 1000000
      });

      // Extract and clean content
      const summary = await extractSummaryFromHtml(res.data, options.topic);

      // Generate tactical summary using GPT-4
      const response = await this.openai.chat([
        { role: "system", content: "You are a summarizer and strategic AI." },
        { role: "user", content: `Given this info from the web, provide a tactical summary:\n\n${summary}` }
      ], {
        model: "gpt-4",
        temperature: 0.3,
        maxTokens: 1500
      });

      if (!response.success) {
        throw new Error(response.error || 'GPT-4 processing failed');
      }

      const result: WebFallbackResult = {
        success: true,
        content: response.content,
        metadata: {
          url: options.url,
          contentLength: res.data.length,
          processedAt: new Date().toISOString(),
          tokensUsed: response.usage?.total_tokens
        }
      };

      const processingTime = Date.now() - startTime;
      logger.info('Web fallback completed', {
        url: options.url,
        processingTime,
        contentLength: res.data.length,
        summaryLength: summary.length,
        tokensUsed: response.usage?.total_tokens
      });

      return result;

    } catch (error: any) {
      const processingTime = Date.now() - startTime;
      
      logger.error('Web fallback failed', {
        url: options.url,
        error: error.message,
        processingTime
      });

      return {
        success: false,
        content: "⚠️ Could not retrieve or summarize external content.",
        error: error.message,
        metadata: {
          url: options.url,
          contentLength: 0,
          processedAt: new Date().toISOString()
        }
      };
    }
  }

  /**
   * Validate if a URL is accessible for web fallback
   */
  async validateUrl(url: string): Promise<{ valid: boolean; error?: string }> {
    try {
      // Perform a HEAD request to check if URL is accessible
      await axios.head(url, {
        headers: { "User-Agent": "ARCANOS/1.0 (Web Intelligence Agent)" },
        timeout: 10000
      });
      
      return { valid: true };
    } catch (error: any) {
      return { 
        valid: false, 
        error: error.message 
      };
    }
  }

  /**
   * Bulk process multiple URLs for web fallback
   */
  async processBatch(requests: Array<{ url: string; topic?: string }>): Promise<WebFallbackResult[]> {
    logger.info('Processing batch web fallback', { count: requests.length });

    const results = await Promise.allSettled(
      requests.map(req => this.fetchAndSummarize(req))
    );

    return results.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      } else {
        return {
          success: false,
          content: "⚠️ Could not retrieve or summarize external content.",
          error: result.reason?.message || 'Unknown error',
          metadata: {
            url: requests[index].url,
            contentLength: 0,
            processedAt: new Date().toISOString()
          }
        };
      }
    });
  }
}

// Export singleton instance
let webFallbackService: WebFallbackService | null = null;

export function getWebFallbackService(): WebFallbackService {
  if (!webFallbackService) {
    webFallbackService = new WebFallbackService();
  }
  return webFallbackService;
}

// Export the service class and main function
export { WebFallbackService };