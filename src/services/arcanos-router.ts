// ARCANOS Intent-Based Router
// Routes inputs to ARCANOS:WRITE or ARCANOS:AUDIT based on intent analysis

import { IntentAnalyzer, IntentType } from './intent-analyzer';
import { ArcanosWriteService, WriteRequest, WriteResponse } from './arcanos-write';
import { ArcanosAuditService, AuditRequest, AuditResponse } from './arcanos-audit';
import { diagnosticsService } from './diagnostics';

export interface RouterRequest {
  message: string;
  domain?: string;
  useRAG?: boolean;
  useHRC?: boolean;
}

export interface RouterResponse {
  success: boolean;
  intent: IntentType;
  confidence: number;
  reasoning: string;
  response: string;
  model?: string;
  error?: string;
  metadata?: {
    service: 'ARCANOS:WRITE' | 'ARCANOS:AUDIT' | 'ARCANOS:DIAGNOSTIC' | 'FALLBACK';
    domain: string;
    timestamp: string;
  };
}

export class ArcanosRouter {
  private intentAnalyzer: IntentAnalyzer;
  private writeService: ArcanosWriteService | null = null;
  private auditService: ArcanosAuditService | null = null;

  constructor() {
    this.intentAnalyzer = new IntentAnalyzer();
    
    // Only initialize services if OpenAI is available
    if (process.env.OPENAI_API_KEY) {
      try {
        this.writeService = new ArcanosWriteService();
        this.auditService = new ArcanosAuditService();
      } catch (error) {
        console.warn('Failed to initialize ARCANOS services:', error);
      }
    }
  }

  async routeRequest(request: RouterRequest): Promise<RouterResponse> {
    const { message, domain = "general", useRAG = true, useHRC = true } = request;
    
    console.log('🎯 ARCANOS Router - Analyzing intent for:', message.substring(0, 100) + '...');
    
    try {
      // Step 1: Analyze intent
      const intentAnalysis = this.intentAnalyzer.analyzeIntent(message);
      console.log(`🧠 Intent Analysis: ${intentAnalysis.intent} (confidence: ${(intentAnalysis.confidence * 100).toFixed(1)}%)`);
      console.log(`💭 Reasoning: ${intentAnalysis.reasoning}`);

      let serviceResponse: any;
      let serviceName: 'ARCANOS:WRITE' | 'ARCANOS:AUDIT' | 'ARCANOS:DIAGNOSTIC' | 'FALLBACK';

      // Step 2: Route to appropriate service based on intent
      if (intentAnalysis.intent === 'DIAGNOSTIC') {
        console.log('🔍 Routing to ARCANOS:DIAGNOSTIC service');
        serviceName = 'ARCANOS:DIAGNOSTIC';
        
        try {
          const diagnosticResult = await diagnosticsService.executeDiagnosticCommand(message);
          
          return {
            success: diagnosticResult.success,
            intent: intentAnalysis.intent,
            confidence: intentAnalysis.confidence,
            reasoning: intentAnalysis.reasoning,
            response: JSON.stringify(diagnosticResult.data, null, 2),
            model: 'ARCANOS:DIAGNOSTIC',
            error: diagnosticResult.error,
            metadata: {
              service: serviceName,
              domain,
              timestamp: new Date().toISOString()
            }
          };
        } catch (error: any) {
          return {
            success: false,
            intent: intentAnalysis.intent,
            confidence: intentAnalysis.confidence,
            reasoning: intentAnalysis.reasoning,
            response: 'ARCANOS:DIAGNOSTIC service error',
            error: error.message,
            metadata: {
              service: serviceName,
              domain,
              timestamp: new Date().toISOString()
            }
          };
        }

      } else if (intentAnalysis.intent === 'WRITE') {
        console.log('📝 Routing to ARCANOS:WRITE service');
        serviceName = 'ARCANOS:WRITE';
        
        if (!this.writeService) {
          return {
            success: false,
            intent: intentAnalysis.intent,
            confidence: intentAnalysis.confidence,
            reasoning: intentAnalysis.reasoning,
            response: 'ARCANOS:WRITE service not available (OpenAI API key required)',
            error: 'Write service not initialized',
            metadata: {
              service: serviceName,
              domain,
              timestamp: new Date().toISOString()
            }
          };
        }
        
        const writeRequest: WriteRequest = {
          message,
          domain,
          useRAG
        };
        
        serviceResponse = await this.writeService.processWriteRequest(writeRequest);
        
        return {
          success: serviceResponse.success,
          intent: intentAnalysis.intent,
          confidence: intentAnalysis.confidence,
          reasoning: intentAnalysis.reasoning,
          response: serviceResponse.content,
          model: serviceResponse.model,
          error: serviceResponse.error,
          metadata: {
            service: serviceName,
            domain,
            timestamp: new Date().toISOString()
          }
        };

      } else if (intentAnalysis.intent === 'AUDIT') {
        console.log('🔍 Routing to ARCANOS:AUDIT service');
        serviceName = 'ARCANOS:AUDIT';
        
        if (!this.auditService) {
          return {
            success: false,
            intent: intentAnalysis.intent,
            confidence: intentAnalysis.confidence,
            reasoning: intentAnalysis.reasoning,
            response: 'ARCANOS:AUDIT service not available (OpenAI API key required)',
            error: 'Audit service not initialized',
            metadata: {
              service: serviceName,
              domain,
              timestamp: new Date().toISOString()
            }
          };
        }
        
        const auditRequest: AuditRequest = {
          message,
          domain,
          useHRC
        };
        
        serviceResponse = await this.auditService.processAuditRequest(auditRequest);
        
        return {
          success: serviceResponse.success,
          intent: intentAnalysis.intent,
          confidence: intentAnalysis.confidence,
          reasoning: intentAnalysis.reasoning,
          response: serviceResponse.auditResult,
          model: serviceResponse.model,
          error: serviceResponse.error,
          metadata: {
            service: serviceName,
            domain,
            timestamp: new Date().toISOString()
          }
        };

      } else {
        // Intent is UNKNOWN - provide fallback response
        console.log('❓ Intent unclear, providing fallback response');
        serviceName = 'FALLBACK';
        
        return {
          success: true,
          intent: intentAnalysis.intent,
          confidence: intentAnalysis.confidence,
          reasoning: intentAnalysis.reasoning,
          response: `I received your message "${message}" but I'm not sure if you want me to write/create content (ARCANOS:WRITE) or validate/audit something (ARCANOS:AUDIT). Could you please clarify your request?`,
          metadata: {
            service: serviceName,
            domain,
            timestamp: new Date().toISOString()
          }
        };
      }

    } catch (error: any) {
      console.error('❌ ARCANOS Router error:', error);
      return {
        success: false,
        intent: 'UNKNOWN',
        confidence: 0,
        reasoning: 'Router error occurred',
        response: `I encountered an error processing your request: ${error.message}`,
        error: error.message,
        metadata: {
          service: 'FALLBACK',
          domain,
          timestamp: new Date().toISOString()
        }
      };
    }
  }
}

// Export the main function for easy integration
export async function processArcanosRequest(request: RouterRequest): Promise<RouterResponse> {
  const router = new ArcanosRouter();
  return await router.routeRequest(request);
}