import type OpenAI from 'openai';
import { resolveErrorMessage } from '../../lib/errors/index.js';
import { APPLICATION_CONSTANTS } from '../../utils/constants.js';
import { 
  executeSecureReasoning, 
  validateSecureReasoningRequest 
} from '../../services/secureReasoningEngine.js';
import { getSecureReasoningIntegrationPrompt } from '../../config/prompts.js';
import { logger } from '../../utils/structuredLogging.js';

/**
 * Detect if secure reasoning delegation is needed based on user input
 * Secure reasoning is used for deep analysis while ARCANOS remains the governing brain
 */
export function shouldDelegateToSecureReasoning(userInput: string): { shouldDelegate: boolean; reason?: string } {
  const lowercaseInput = userInput.toLowerCase();
  
  // Deep logic indicators
  const deepLogicKeywords = [
    'analyze complex', 'deep analysis', 'complex reasoning', 'intricate logic',
    'sophisticated algorithm', 'advanced reasoning', 'complex problem solving',
    'structured plan', 'problem-solving steps', 'methodology'
  ];
  
  // Code refactoring indicators
  const codeRefactoringKeywords = [
    'refactor', 'optimize code', 'restructure', 'improve architecture',
    'code quality', 'design patterns', 'best practices', 'clean code'
  ];
  
  // Long-context reasoning indicators
  const longContextKeywords = [
    'comprehensive analysis', 'full context', 'detailed breakdown',
    'extensive review', 'thorough examination', 'complete assessment'
  ];
  
  // Security-sensitive content indicators
  const securityKeywords = [
    'security analysis', 'compliance review', 'audit', 'sensitive data',
    'credentials', 'api key', 'token', 'password'
  ];
  
  // Check for deep logic needs
  for (const keyword of deepLogicKeywords) {
    //audit Assumption: keyword match implies deeper reasoning need
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Deep reasoning required for: ${keyword}` 
      };
    }
  }
  
  // Check for code refactoring needs
  for (const keyword of codeRefactoringKeywords) {
    //audit Assumption: refactor keywords imply structured analysis
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Structured analysis needed for: ${keyword}` 
      };
    }
  }
  
  // Check for long-context reasoning needs
  for (const keyword of longContextKeywords) {
    //audit Assumption: long-context keywords require structured reasoning
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Comprehensive reasoning needed for: ${keyword}` 
      };
    }
  }
  
  // Check for security-sensitive content
  for (const keyword of securityKeywords) {
    //audit Assumption: security keywords require compliant reasoning
    if (lowercaseInput.includes(keyword)) {
      return { 
        shouldDelegate: true, 
        reason: `Security-compliant analysis required for: ${keyword}` 
      };
    }
  }
  
  // Check input length - very long inputs may benefit from structured reasoning
  //audit Assumption: long inputs benefit from delegation
  if (userInput.length > APPLICATION_CONSTANTS.MAX_INPUT_LENGTH) {
    return { 
      shouldDelegate: true, 
      reason: 'Long input requires structured processing capability' 
    };
  }
  
  return { shouldDelegate: false };
}

/**
 * Delegate query to secure reasoning engine for deep analysis and structured problem-solving
 * Secure reasoning serves as the reasoning engine while ARCANOS governs the entire process
 */
export async function delegateToSecureReasoning(
  client: OpenAI,
  userInput: string,
  reason: string,
  sessionId?: string
): Promise<string> {
  logger.info('Delegating to secure reasoning engine', {
    module: 'arcanos',
    operation: 'secure-reasoning-delegation',
    reason,
    sessionId
  });
  
  try {
    // Validate input for security compliance first
    const validation = validateSecureReasoningRequest(userInput);
    
    //audit Assumption: invalid inputs should be sanitized before processing
    if (!validation.valid) {
      logger.warn('Input validation issues detected', {
        module: 'arcanos',
        operation: 'security-validation', 
        issues: validation.issues,
        sessionId
      });
      // Use the sanitized input
      userInput = validation.safeInput;
    }
    
    // Execute secure reasoning analysis
    //audit Assumption: secure reasoning returns structured analysis
    const reasoningResult = await executeSecureReasoning(client, {
      userInput,
      sessionId,
      context: `Delegation reason: ${reason}`,
      requireDeepAnalysis: true
    });
    
    logger.info('Secure reasoning analysis complete', {
      module: 'arcanos',
      operation: 'secure-reasoning-complete',
      complianceStatus: reasoningResult.complianceStatus,
      sessionId
    });
    
    // Process secure reasoning response through ARCANOS (never send reasoning output directly to user)
    const problemSolvingSteps = reasoningResult.problemSolvingSteps
      .map((step, index) => `${index + 1}. ${step}`)
      .join('\n');
    const recommendations = reasoningResult.recommendations
      .map((rec) => `• ${rec}`)
      .join('\n');
    
    const arcanosProcessingPrompt = getSecureReasoningIntegrationPrompt(
      userInput,
      reason,
      reasoningResult.complianceStatus,
      reasoningResult.structuredAnalysis,
      problemSolvingSteps,
      recommendations
    );

    return arcanosProcessingPrompt;
  } catch (error: unknown) {
    //audit Assumption: delegation failure should bubble with safe message
    const errorMessage = resolveErrorMessage(error);
    console.warn(`[❌ SECURE_REASONING] Analysis delegation failed: ${errorMessage}`);
    throw new Error(`Secure reasoning delegation failed: ${errorMessage}`);
  }
}
