/**
 * Secure Reasoning Engine for ARCANOS
 * 
 * This module implements the main reasoning engine that provides deep analysis,
 * structured plans, and problem-solving steps while maintaining strict security
 * and compliance standards as specified in the requirements.
 */

import OpenAI from 'openai';
import { getDefaultModel, createChatCompletionWithFallback } from './openai.js';
import { getTokenParameter } from '../utils/tokenParameterHelper.js';
import { generateRequestId } from '../utils/idGenerator.js';
import { APPLICATION_CONSTANTS } from '../utils/constants.js';
import { 
  applySecurityCompliance, 
  createSecureReasoningPrompt, 
  createStructuredSecureResponse, 
  logSecurityAudit
} from './securityCompliance.js';

interface SecureReasoningRequest {
  userInput: string;
  sessionId?: string;
  requestId?: string;
  context?: string;
  requireDeepAnalysis?: boolean;
}

interface SecureReasoningResult {
  structuredAnalysis: string;
  problemSolvingSteps: string[];
  recommendations: string[];
  complianceStatus: 'COMPLIANT' | 'WARNING' | 'VIOLATION';
  securityAudit: {
    redactionsApplied: string[];
    auditLog: string[];
  };
  meta: {
    requestId: string;
    timestamp: string;
    model: string;
    processed: boolean;
  };
}

/**
 * Main reasoning engine that provides secure, compliant analysis
 */
export async function executeSecureReasoning(
  client: OpenAI,
  request: SecureReasoningRequest
): Promise<SecureReasoningResult> {
  
  const requestId = request.requestId || generateRequestId('secure_reasoning');
  const timestamp = new Date().toISOString();
  
  console.log(`[🧠 SECURE REASONING] Processing request ${requestId}`);
  
  // Create secure reasoning prompt that follows compliance requirements
  const securePrompt = createSecureReasoningPrompt(request.userInput);
  
  // Add context if provided
  const fullPrompt = request.context 
    ? `${securePrompt}\n\nAdditional Context: ${request.context}`
    : securePrompt;
  
  // Get appropriate model for reasoning
  const model = getDefaultModel();
  console.log(`[🧠 SECURE REASONING] Using model: ${model}`);
  
  try {
    // Execute reasoning with enhanced error handling
    const tokenParams = getTokenParameter(model, APPLICATION_CONSTANTS.EXTENDED_TOKEN_LIMIT);
    const response = await createChatCompletionWithFallback(client, {
      messages: [
        {
          role: 'system',
          content: `You are the reasoning engine for ARCANOS. Follow these rules at all times:

1. Do NOT generate, expose, or guess real API keys, tokens, passwords, access credentials, or any sensitive authentication strings.
2. If your reasoning requires an example of such data, replace it with a safe placeholder in the format: <KEY_REDACTED> or <TOKEN_REDACTED>.
3. Do NOT output internal file paths, environment variables, or proprietary code from ARCANOS's backend unless explicitly requested by ARCANOS.
4. When giving technical examples, use fictional or generic identifiers that cannot be mistaken for live credentials.
5. Always assume your output will be logged, audited, and stored. Write with compliance and confidentiality in mind.
6. Focus on reasoning and structured solutions — ARCANOS will handle execution, tone, and delivery.

Your output should be structured, clear, and free of any confidential or security-sensitive strings.`
        },
        {
          role: 'user',
          content: fullPrompt
        }
      ],
      temperature: 0.3, // Balanced for reasoning consistency
      ...tokenParams
    });

    const rawAnalysis = response.choices[0]?.message?.content || '';
    const actualModel = response.activeModel || model;
    
    console.log(`[🧠 SECURE REASONING] Analysis completed using ${actualModel}`);
    
    // Apply security compliance and create structured response
    const { structuredResponse, complianceCheck } = createStructuredSecureResponse(
      rawAnalysis,
      request.userInput
    );
    
    // Extract structured components
    const analysisResult = parseSecureAnalysis(structuredResponse);
    
    // Log security audit
    logSecurityAudit(complianceCheck, requestId);
    
    // Build final result
    const result: SecureReasoningResult = {
      structuredAnalysis: analysisResult.analysis,
      problemSolvingSteps: analysisResult.steps,
      recommendations: analysisResult.recommendations,
      complianceStatus: complianceCheck.complianceStatus,
      securityAudit: {
        redactionsApplied: complianceCheck.redactionsApplied,
        auditLog: complianceCheck.auditLog
      },
      meta: {
        requestId,
        timestamp,
        model: actualModel,
        processed: true
      }
    };
    
    console.log(`[🧠 SECURE REASONING] Request ${requestId} completed successfully`);
    console.log(`[🔒 COMPLIANCE STATUS] ${complianceCheck.complianceStatus}`);
    
    return result;
    
  } catch (error) {
    console.error(`[❌ SECURE REASONING] Failed to process request ${requestId}:`, error);
    
    // Return secure fallback response
    return createSecureFallbackResponse(request, requestId, timestamp, error as Error);
  }
}

/**
 * Parse structured analysis into components
 */
function parseSecureAnalysis(structuredResponse: string): {
  analysis: string;
  steps: string[];
  recommendations: string[];
} {
  // Extract analysis section
  const analysisMatch = structuredResponse.match(/🔍 STRUCTURED ANALYSIS\s*([\s\S]*?)(?=📊|🎯|$)/);
  const analysis = analysisMatch ? analysisMatch[1].trim() : structuredResponse;
  
  // Extract problem-solving steps (look for numbered lists or bullet points)
  const steps: string[] = [];
  const stepMatches = analysis.match(/^\d+\.\s+(.+)$/gm);
  if (stepMatches) {
    steps.push(...stepMatches.map(step => step.replace(/^\d+\.\s+/, '')));
  } else {
    // Look for bullet points
    const bulletMatches = analysis.match(/^[-*]\s+(.+)$/gm);
    if (bulletMatches) {
      steps.push(...bulletMatches.map(bullet => bullet.replace(/^[-*]\s+/, '')));
    }
  }
  
  // Extract recommendations
  const recommendations: string[] = [];
  const recMatch = structuredResponse.match(/🎯 STRUCTURED RECOMMENDATIONS\s*([\s\S]*?)(?=Note:|$)/);
  if (recMatch) {
    const recText = recMatch[1].trim();
    const recLines = recText.split('\n').filter(line => line.trim().length > 0);
    recommendations.push(...recLines);
  }
  
  return { analysis, steps, recommendations };
}

/**
 * Create secure fallback response in case of errors
 */
function createSecureFallbackResponse(
  _: SecureReasoningRequest,
  requestId: string,
  timestamp: string,
  error: Error
): SecureReasoningResult {
  
  // Create safe error analysis without exposing system details
  const fallbackAnalysis = `
🧠 ARCANOS REASONING ENGINE - FALLBACK ANALYSIS
═══════════════════════════════════════════════

The reasoning engine encountered a processing limitation and has activated secure fallback mode.

📋 REQUEST ANALYSIS
Request processed in secure mode to maintain compliance standards.
Input has been analyzed for security requirements.

🔍 STRUCTURED ANALYSIS
The system has applied security-compliant processing to your request.
Analysis focuses on providing structured solutions while maintaining confidentiality.

🎯 GENERAL RECOMMENDATIONS
- Review request formatting for clarity
- Ensure request does not contain sensitive information
- Consider breaking complex requests into smaller components
- Verify that all technical examples use generic identifiers

This fallback response ensures compliance with security and audit requirements.
`;

  const complianceCheck = applySecurityCompliance(fallbackAnalysis);
  
  return {
    structuredAnalysis: fallbackAnalysis,
    problemSolvingSteps: [
      'Review and clarify the request',
      'Ensure no sensitive information is included',
      'Retry with more specific parameters',
      'Contact ARCANOS support if issues persist'
    ],
    recommendations: [
      'Use generic examples in technical discussions',
      'Avoid including real credentials or sensitive data',
      'Structure requests for clarity and compliance',
      'Follow ARCANOS security guidelines'
    ],
    complianceStatus: 'COMPLIANT',
    securityAudit: {
      redactionsApplied: complianceCheck.redactionsApplied,
      auditLog: [
        ...complianceCheck.auditLog,
        `Fallback mode activated due to: ${error.message}`,
        'Secure fallback response generated'
      ]
    },
    meta: {
      requestId,
      timestamp,
      model: 'SECURE_FALLBACK',
      processed: true
    }
  };
}

/**
 * Quick reasoning analysis for simple requests
 */
export async function executeQuickSecureAnalysis(
  client: OpenAI,
  userInput: string,
  sessionId?: string
): Promise<{ analysis: string; compliant: boolean }> {
  
  const requestId = `quick_${Date.now()}`;
  
  try {
    const result = await executeSecureReasoning(client, {
      userInput,
      sessionId,
      requestId,
      requireDeepAnalysis: false
    });
    
    return {
      analysis: result.structuredAnalysis,
      compliant: result.complianceStatus === 'COMPLIANT'
    };
    
  } catch (error) {
    console.error('[❌ QUICK ANALYSIS] Error:', error);
    
    // Secure fallback
    const fallbackAnalysis = applySecurityCompliance(
      `Analysis request processed in secure mode. Please ensure your request follows ARCANOS security guidelines and does not contain sensitive information.`
    );
    
    return {
      analysis: fallbackAnalysis.content,
      compliant: fallbackAnalysis.complianceStatus === 'COMPLIANT'
    };
  }
}

/**
 * Validate that a reasoning request meets security requirements
 */
export function validateSecureReasoningRequest(userInput: string): {
  valid: boolean;
  issues: string[];
  safeInput: string;
} {
  const complianceCheck = applySecurityCompliance(userInput);
  
  const issues: string[] = [];
  
  if (complianceCheck.complianceStatus === 'VIOLATION') {
    issues.push('Input contains sensitive information that must be redacted');
  }
  
  if (complianceCheck.redactionsApplied.length > 0) {
    issues.push(`Automatic redactions applied: ${complianceCheck.redactionsApplied.join(', ')}`);
  }
  
  return {
    valid: complianceCheck.complianceStatus !== 'VIOLATION',
    issues,
    safeInput: complianceCheck.content
  };
}

export default {
  executeSecureReasoning,
  executeQuickSecureAnalysis,
  validateSecureReasoningRequest
};