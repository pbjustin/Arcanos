import type OpenAI from 'openai';
import { applySecurityCompliance } from "@services/securityCompliance.js";
import type { AuditSafeConfig } from "@services/auditSafe.js";
import type { MemoryContext } from "@services/memoryAware.js";
import type { ArcanosResult } from './types.js';

export function parseArcanosResponse(
  fullResult: string, 
  response: OpenAI.Chat.Completions.ChatCompletion, 
  activeModel: string, 
  fallbackFlag: boolean,
  reasoningDelegation?: { used: boolean; reason?: string; delegatedQuery?: string },
  auditConfig?: AuditSafeConfig,
  memoryContext?: MemoryContext,
  auditFlags?: string[],
  processedSafely?: boolean,
  requestId?: string
): ArcanosResult {
  // Parse the structured response
  const componentStatusMatch = fullResult.match(/✅ Component Status Table\s*([\s\S]*?)(?=🛠|$)/);
  const suggestedFixesMatch = fullResult.match(/🛠 Suggested Fixes\s*([\s\S]*?)(?=🧠|$)/);
  const coreLogicTraceMatch = fullResult.match(/🧠 Core Logic Trace\s*([\s\S]*?)$/);
  
  const componentStatus = componentStatusMatch ? componentStatusMatch[1].trim() : 'Status information not available';
  const suggestedFixes = suggestedFixesMatch ? suggestedFixesMatch[1].trim() : 'No fixes suggested';
  let coreLogicTrace = coreLogicTraceMatch ? coreLogicTraceMatch[1].trim() : 'Logic trace not available';
  
  // Add secure reasoning delegation info to logic trace if used
  //audit Assumption: include delegation context for auditability
  if (reasoningDelegation?.used) {
    coreLogicTrace = `Secure Reasoning Delegation: ${reasoningDelegation.reason}\nOriginal Query: ${reasoningDelegation.delegatedQuery}\n\n${coreLogicTrace}`;
  }
  
  // Add memory context info to logic trace
  //audit Assumption: include memory context when used
  if (memoryContext && memoryContext.relevantEntries.length > 0) {
    coreLogicTrace = `Memory Context: ${memoryContext.contextSummary}\nMemory Accessed: [${memoryContext.accessLog.join(', ')}]\n\n${coreLogicTrace}`;
  }

  // Apply security compliance to the final result
  const securityCheck = applySecurityCompliance(fullResult);
  //audit Assumption: non-compliant output must be redacted
  if (securityCheck.complianceStatus !== 'COMPLIANT') {
    console.warn(`[🔒 SECURITY] Compliance issue detected: ${securityCheck.complianceStatus}`);
    // Use the redacted content
    fullResult = securityCheck.content;
    auditFlags?.push('SECURITY_REDACTION_APPLIED');
  }

  return {
    result: fullResult,
    componentStatus,
    suggestedFixes,
    coreLogicTrace,
    activeModel,
    fallbackFlag,
    reasoningDelegation,
    gpt5Used: true,
    auditSafe: {
      mode: auditConfig?.auditSafeMode ?? true,
      overrideUsed: !!auditConfig?.explicitOverride,
      overrideReason: auditConfig?.overrideReason,
      auditFlags: auditFlags || [],
      processedSafely: processedSafely ?? true
    },
    memoryContext: {
      entriesAccessed: memoryContext?.relevantEntries.length || 0,
      contextSummary: memoryContext?.contextSummary || 'No memory context available',
      memoryEnhanced: (memoryContext?.relevantEntries.length || 0) > 0
    },
    taskLineage: {
      requestId: requestId || 'unknown',
      logged: true
    },
    meta: {
      tokens: response.usage || undefined,
      id: response.id,
      created: response.created,
    },
  };
}
