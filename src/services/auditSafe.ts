/**
 * ARCANOS Audit-Safe Mode Service
 * 
 * Implements audit-safe mode as the default operating mode for ARCANOS
 * with explicit override capability. All AI interactions are logged and
 * validated for audit compliance.
 */

import { appendFileSync } from 'fs';
import { getAuditLogPath, getLineageLogPath, ensureLogDirectory } from '../utils/logPath.js';
import { generateRequestId } from '../utils/idGenerator.js';
import {
  AUDIT_SAFE_NON_COMPLIANT_PATTERNS,
  AUDIT_SAFE_OVERRIDE_PATTERNS,
  AUDIT_SAFE_SENSITIVE_PATTERNS,
  AUDIT_SAFE_SYSTEM_PROMPT_SUFFIX,
  AUDIT_SAFE_USER_PROMPT_TEMPLATE,
  AUDIT_LINEAGE_TEMPLATE
} from '../config/auditSafe.js';

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
  gpt4Delegated?: boolean;  // New field for GPT-4 delegation
  gpt5Delegated?: boolean;  // Keep for backward compatibility
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
  const normalizedInput = userInput.toLowerCase();

  const hasOverride = overrideFlag || AUDIT_SAFE_OVERRIDE_PATTERNS.some(pattern =>
    normalizedInput.includes(pattern.toLowerCase())
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

${AUDIT_SAFE_SYSTEM_PROMPT_SUFFIX}`;

  // Check for potentially sensitive content
  const normalizedUserPrompt = userPrompt.toLowerCase();

  for (const pattern of AUDIT_SAFE_SENSITIVE_PATTERNS) {
    if (normalizedUserPrompt.includes(pattern)) {
      auditFlags.push(`SENSITIVE_CONTENT_DETECTED:${pattern}`);
    }
  }

  // Add audit metadata to user prompt
  const requestId = generateRequestId('arc');
  const auditSafeUserPrompt = formatAuditSafeUserPrompt(
    userPrompt,
    requestId,
    new Date().toISOString()
  );

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
    appendFileSync(LINEAGE_LOG_FILE, formatAuditLineage(entry));

    console.log(`📋 [AUDIT] Task logged: ${entry.requestId} | Endpoint: ${entry.endpoint} | AuditSafe: ${entry.auditSafeMode}`);
  } catch (error) {
    console.error('❌ Failed to write audit log:', error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Validate that output is audit-safe
 */
export function validateAuditSafeOutput(output: string, auditConfig: AuditSafeConfig): boolean {
  if (!auditConfig.auditSafeMode) {
    return true; // No validation needed when audit-safe mode is disabled
  }

  // Check for audit compliance patterns
  const normalizedOutput = output.toLowerCase();

  for (const pattern of AUDIT_SAFE_NON_COMPLIANT_PATTERNS) {
    if (normalizedOutput.includes(pattern)) {
      console.warn(`⚠️ [AUDIT] Potentially non-compliant output detected: ${pattern}`);
      return false;
    }
  }

  return true;
}

function formatAuditSafeUserPrompt(userPrompt: string, requestId: string, timestamp: string): string {
  return AUDIT_SAFE_USER_PROMPT_TEMPLATE
    .replace('{{timestamp}}', timestamp)
    .replace('{{requestId}}', requestId)
    .replace('{{userPrompt}}', userPrompt);
}

function formatAuditLineage(entry: AuditLogEntry): string {
  const flags = entry.auditFlags.join(',');

  return AUDIT_LINEAGE_TEMPLATE
    .replace('{{timestamp}}', entry.timestamp)
    .replace('{{requestId}}', entry.requestId)
    .replace('{{endpoint}}', entry.endpoint)
    .replace('{{modelUsed}}', entry.modelUsed)
    .replace('{{gpt5Delegated}}', String(entry.gpt5Delegated ?? false))
    .replace('{{auditSafeMode}}', String(entry.auditSafeMode))
    .replace('{{auditFlags}}', flags);
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