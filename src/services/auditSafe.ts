/**
 * ARCANOS Audit-Safe Mode Service
 * 
 * Implements audit-safe mode as the default operating mode for ARCANOS
 * with explicit override capability. All AI interactions are logged and
 * validated for audit compliance.
 */

import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getLogPath, getAuditLogPath, getLineageLogPath, ensureLogDirectory } from '../utils/logPath.js';

export interface AuditSafeConfig {
  auditSafeMode: boolean;
  explicitOverride?: string;
  overrideReason?: string;
}

export interface AuditLogEntry {
  timestamp: string;
  requestId: string;
  endpoint: string;
  auditSafeMode: boolean;
  overrideUsed: boolean;
  overrideReason?: string;
  inputSummary: string;
  outputSummary: string;
  modelUsed: string;
  gpt5Delegated: boolean;
  delegationReason?: string;
  memoryAccessed: string[];
  processedSafely: boolean;
  auditFlags: string[];
}

// Audit log directory and files - now using centralized log path management
const AUDIT_LOG_FILE = getAuditLogPath();
const LINEAGE_LOG_FILE = getLineageLogPath();

// Ensure log directory exists is now handled by ensureLogDirectory() function

/**
 * Determine if audit-safe mode should be active
 */
export function getAuditSafeConfig(
  userInput: string, 
  overrideFlag?: string
): AuditSafeConfig {
  // Check for explicit override patterns
  const overridePatterns = [
    'ARCANOS_OVERRIDE_AUDIT_SAFE',
    'override audit safe',
    'disable audit mode',
    'emergency override'
  ];

  const hasOverride = overrideFlag || overridePatterns.some(pattern => 
    userInput.toLowerCase().includes(pattern.toLowerCase())
  );

  if (hasOverride) {
    console.log('⚠️ [AUDIT-SAFE] Override detected - disabling audit-safe mode');
    return {
      auditSafeMode: false,
      explicitOverride: overrideFlag || 'user_request',
      overrideReason: 'Explicit override requested in user input'
    };
  }

  // Default to audit-safe mode
  return {
    auditSafeMode: true
  };
}

/**
 * Apply audit-safe constraints to AI processing
 */
export function applyAuditSafeConstraints(
  systemPrompt: string, 
  userPrompt: string,
  auditConfig: AuditSafeConfig
): { systemPrompt: string; userPrompt: string; auditFlags: string[] } {
  
  const auditFlags: string[] = [];

  if (!auditConfig.auditSafeMode) {
    auditFlags.push('AUDIT_SAFE_DISABLED');
    return { systemPrompt, userPrompt, auditFlags };
  }

  // Enhanced system prompt for audit-safe mode
  const auditSafeSystemPrompt = `${systemPrompt}

[AUDIT-SAFE MODE ACTIVE]
- All responses must be auditable and traceable
- Log all reasoning and decision paths clearly
- Avoid sensitive data exposure in logs
- Maintain professional, compliant language
- Document any external tool or model invocations
- Ensure reproducible decision-making processes

AUDIT REQUIREMENT: Your response will be logged for compliance review.`;

  // Check for potentially sensitive content
  const sensitivePatterns = [
    'password', 'credential', 'secret', 'private key',
    'confidential', 'classified', 'personal information'
  ];

  for (const pattern of sensitivePatterns) {
    if (userPrompt.toLowerCase().includes(pattern)) {
      auditFlags.push(`SENSITIVE_CONTENT_DETECTED:${pattern}`);
    }
  }

  // Add audit metadata to user prompt
  const auditSafeUserPrompt = `[AUDIT-SAFE REQUEST]
Timestamp: ${new Date().toISOString()}
Mode: AUDIT_SAFE_ENABLED
Request ID: ${generateRequestId()}

${userPrompt}

[AUDIT DIRECTIVE: Provide a complete, auditable response with clear reasoning.]`;

  auditFlags.push('AUDIT_SAFE_ACTIVE');
  
  return { 
    systemPrompt: auditSafeSystemPrompt, 
    userPrompt: auditSafeUserPrompt, 
    auditFlags 
  };
}

/**
 * Log AI task lineage for audit trail
 */
export function logAITaskLineage(entry: AuditLogEntry) {
  ensureLogDirectory();
  
  try {
    // Detailed audit log
    const auditLine = JSON.stringify(entry) + '\n';
    appendFileSync(AUDIT_LOG_FILE, auditLine);

    // Human-readable lineage log
    const lineageLine = `${entry.timestamp} | ${entry.requestId} | ${entry.endpoint} | Model:${entry.modelUsed} | GPT5:${entry.gpt5Delegated} | AuditSafe:${entry.auditSafeMode} | Flags:[${entry.auditFlags.join(',')}]\n`;
    appendFileSync(LINEAGE_LOG_FILE, lineageLine);

    console.log(`📋 [AUDIT] Task logged: ${entry.requestId} | Endpoint: ${entry.endpoint} | AuditSafe: ${entry.auditSafeMode}`);
  } catch (error) {
    console.error('❌ Failed to write audit log:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Generate unique request ID for tracking
 */
function generateRequestId(): string {
  return `arc_${Date.now()}_${Math.random().toString(36).substring(7)}`;
}

/**
 * Validate that output is audit-safe
 */
export function validateAuditSafeOutput(output: string, auditConfig: AuditSafeConfig): boolean {
  if (!auditConfig.auditSafeMode) {
    return true; // No validation needed when audit-safe mode is disabled
  }

  // Check for audit compliance patterns
  const nonCompliantPatterns = [
    'ignore previous instructions',
    'confidential', 'classified',
    'bypass audit', 'disable logging'
  ];

  for (const pattern of nonCompliantPatterns) {
    if (output.toLowerCase().includes(pattern)) {
      console.warn(`⚠️ [AUDIT] Potentially non-compliant output detected: ${pattern}`);
      return false;
    }
  }

  return true;
}

/**
 * Create audit summary for logging
 */
export function createAuditSummary(
  text: string, 
  maxLength: number = 100
): string {
  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
  return cleaned.length > maxLength 
    ? cleaned.substring(0, maxLength) + '...'
    : cleaned;
}