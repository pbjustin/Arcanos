// ARCANOS:AUDIT - Content validation and audit service
// Handles requests that require validation, checking, or auditing

import { OpenAIService, ChatMessage } from './openai';
import { HRCCore } from '../modules/hrc';

export interface AuditRequest {
  message: string;
  domain?: string;
  useHRC?: boolean;
}

export interface AuditResponse {
  success: boolean;
  auditResult: string;
  model?: string;
  error?: string;
  hrcValidation?: {
    success: boolean;
    data: any;
  };
  metadata?: {
    domain: string;
    useHRC: boolean;
    timestamp: string;
  };
}

export class ArcanosAuditService {
  private openaiService: OpenAIService | null;
  private hrcCore: HRCCore;

  constructor() {
    try {
      this.openaiService = new OpenAIService();
    } catch (error) {
      console.warn('⚠️ ArcanosAuditService: OpenAI not available, running in testing mode');
      this.openaiService = null;
    }
    this.hrcCore = new HRCCore();
  }

  async processAuditRequest(request: AuditRequest): Promise<AuditResponse> {
    const { message, domain = "general", useHRC = true } = request;
    
    console.log(`🔍 ARCANOS:AUDIT - Processing validation request in domain: ${domain}`);
    
    try {
      let hrcValidation = null;

      // Step 1: HRC validation if requested
      if (useHRC) {
        try {
          hrcValidation = await this.hrcCore.validate(message, { domain });
          console.log('🛡️ HRC validation completed:', hrcValidation);
        } catch (error: any) {
          console.warn("HRC validation failed:", error.message);
          hrcValidation = { success: false, data: null };
        }
      }

      // Step 2: Build system prompt for audit/validation
      const systemPrompt = this.buildAuditSystemPrompt(domain);

      // Step 3: Perform AI-powered audit/validation
      const chatMessages: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: message }
      ];

      console.log('🚀 Performing AI audit/validation...');
      
      let openaiResponse;
      if (this.openaiService) {
        openaiResponse = await this.openaiService.chat(chatMessages);
      } else {
        // Mock response when OpenAI is not available
        openaiResponse = {
          message: `[TESTING MODE] Mock audit response for: "${message}". Analysis: Content reviewed for domain: ${domain}. In a real environment with OpenAI configured, this would be a detailed audit result.`,
          model: 'mock-model',
          error: null
        };
      }

      if (openaiResponse.error) {
        console.error('❌ OpenAI error in AUDIT service:', openaiResponse.error);
        return {
          success: false,
          auditResult: '',
          error: openaiResponse.error,
          model: openaiResponse.model,
          hrcValidation: hrcValidation || undefined,
          metadata: {
            domain,
            useHRC,
            timestamp: new Date().toISOString()
          }
        };
      }

      console.log('✅ ARCANOS:AUDIT - Successfully completed audit/validation');
      return {
        success: true,
        auditResult: openaiResponse.message,
        model: openaiResponse.model,
        hrcValidation: hrcValidation || undefined,
        metadata: {
          domain,
          useHRC,
          timestamp: new Date().toISOString()
        }
      };

    } catch (error: any) {
      console.error('❌ ARCANOS:AUDIT error:', error);
      return {
        success: false,
        auditResult: '',
        error: `AUDIT service error: ${error.message}`,
        metadata: {
          domain,
          useHRC,
          timestamp: new Date().toISOString()
        }
      };
    }
  }

  private buildAuditSystemPrompt(domain: string): string {
    return `You are ARCANOS in AUDIT mode. Your role is to validate, check, review, and audit content with precision and accuracy.

Domain: ${domain}

Focus on:
- Thorough validation and verification
- Accuracy and correctness assessment
- Quality control and compliance checking
- Detailed analysis and evaluation
- Clear audit findings and recommendations
- Identification of issues, errors, or improvements needed

Provide structured, analytical responses that:
1. Clearly state what was audited/validated
2. Identify any issues or concerns found
3. Confirm what is correct and valid
4. Recommend improvements or corrections if needed
5. Provide confidence levels in your assessments`;
  }
}