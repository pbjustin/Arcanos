/**
 * Security Compliance Service for ARCANOS Reasoning Engine
 * 
 * This service ensures that all reasoning outputs comply with security requirements:
 * - Redacts sensitive information (API keys, tokens, passwords)
 * - Replaces internal paths and environment variables with safe placeholders
 * - Maintains structured output while ensuring confidentiality and compliance
 * - Provides deep analysis and problem-solving without exposing sensitive data
 */

interface SecurityConfig {
  redactCredentials: boolean;
  redactFilePaths: boolean;
  redactEnvironmentVars: boolean;
  redactInternalDetails: boolean;
  allowGenericExamples: boolean;
}

interface RedactionResult {
  content: string;
  redactionsApplied: string[];
  complianceStatus: 'COMPLIANT' | 'WARNING' | 'VIOLATION';
  auditLog: string[];
}

/**
 * Default security configuration for ARCANOS reasoning engine
 */
const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  redactCredentials: true,
  redactFilePaths: true,
  redactEnvironmentVars: true,
  redactInternalDetails: true,
  allowGenericExamples: true
};

/**
 * Patterns for detecting sensitive information that must be redacted
 */
const SENSITIVE_PATTERNS = {
  // API Keys and Tokens
  apiKeys: [
    /OPENAI_API_KEY[=:\s]*['"]*([a-zA-Z0-9_-]{20,})['"]*$/gmi,
    /API_KEY[=:\s]*['"]*([a-zA-Z0-9_-]{20,})['"]*$/gmi,
    /sk-[a-zA-Z0-9]{20,}/gi,
    /\b[a-zA-Z0-9]{32,}\b/g
  ],
  
  // GitHub and other service tokens
  tokens: [
    /GITHUB_TOKEN[=:\s]*['"]*([a-zA-Z0-9_-]{20,})['"]*$/gmi,
    /WEBHOOK_SECRET[=:\s]*['"]*([a-zA-Z0-9_-]{8,})['"]*$/gmi,
    /ADMIN_KEY[=:\s]*['"]*([a-zA-Z0-9_-]{8,})['"]*$/gmi,
    /ghp_[a-zA-Z0-9]{36}/gi,
    /github_pat_[a-zA-Z0-9_]{82}/gi
  ],
  
  // Database credentials and connection strings
  credentials: [
    /DATABASE_URL[=:\s]*['"]*([^'"]+)['"]*$/gmi,
    /postgresql:\/\/[^@]+:[^@]+@[^\/]+\/[^'"'\s]+/gi,
    /mysql:\/\/[^@]+:[^@]+@[^\/]+\/[^'"'\s]+/gi,
    /password[=:\s]*['"]*([^'"'\s]{4,})['"]*$/gmi,
    /passwd[=:\s]*['"]*([^'"'\s]{4,})['"]*$/gmi
  ],
  
  // File paths and internal system details
  filePaths: [
    /\/home\/[^\/\s]+\/[^\s]*/gi,
    /\/var\/[^\/\s]+\/[^\s]*/gi,
    /\/tmp\/[^\/\s]+\/[^\s]*/gi,
    /\/usr\/[^\/\s]+\/[^\s]*/gi,
    /C:\\[^\\]+\\[^\s]*/gi,
    /\\\\[^\\]+\\[^\s]*/gi
  ],
  
  // Environment variables
  envVars: [
    /process\.env\.[A-Z_]+/gi,
    /\$[A-Z_]+[=\s]/gi,
    /export\s+[A-Z_]+=/gi
  ],
  
  // Model IDs and internal identifiers
  internalIds: [
    /ft:gpt-[^:]+:[^:]+:[^:]+:[a-zA-Z0-9]+/gi,
    /[a-zA-Z0-9]{8}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{4}-[a-zA-Z0-9]{12}/gi
  ]
};

/**
 * Safe placeholder patterns to replace sensitive information
 */
const SAFE_PLACEHOLDERS = {
  apiKey: '<API_KEY_REDACTED>',
  token: '<TOKEN_REDACTED>',
  credential: '<CREDENTIAL_REDACTED>',
  filePath: '<FILE_PATH_REDACTED>',
  envVar: '<ENV_VAR_REDACTED>',
  internalId: '<INTERNAL_ID_REDACTED>',
  modelId: '<MODEL_ID_REDACTED>',
  database: '<DATABASE_URL_REDACTED>'
};

/**
 * Apply security compliance redaction to content
 */
export function applySecurityCompliance(
  content: string,
  config: SecurityConfig = DEFAULT_SECURITY_CONFIG
): RedactionResult {
  let processedContent = content;
  const redactionsApplied: string[] = [];
  const auditLog: string[] = [];
  
  auditLog.push(`Security compliance check initiated at ${new Date().toISOString()}`);
  auditLog.push(`Configuration: ${JSON.stringify(config)}`);
  
  // Redact API keys and tokens
  if (config.redactCredentials) {
    SENSITIVE_PATTERNS.apiKeys.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.apiKey);
        redactionsApplied.push(`API_KEY_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} API key(s) using pattern ${index + 1}`);
      }
    });
    
    SENSITIVE_PATTERNS.tokens.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.token);
        redactionsApplied.push(`TOKEN_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} token(s) using pattern ${index + 1}`);
      }
    });
    
    SENSITIVE_PATTERNS.credentials.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.credential);
        redactionsApplied.push(`CREDENTIAL_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} credential(s) using pattern ${index + 1}`);
      }
    });
  }
  
  // Redact file paths
  if (config.redactFilePaths) {
    SENSITIVE_PATTERNS.filePaths.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.filePath);
        redactionsApplied.push(`FILE_PATH_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} file path(s) using pattern ${index + 1}`);
      }
    });
  }
  
  // Redact environment variables
  if (config.redactEnvironmentVars) {
    SENSITIVE_PATTERNS.envVars.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.envVar);
        redactionsApplied.push(`ENV_VAR_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} environment variable(s) using pattern ${index + 1}`);
      }
    });
  }
  
  // Redact internal IDs and model identifiers
  if (config.redactInternalDetails) {
    SENSITIVE_PATTERNS.internalIds.forEach((pattern, index) => {
      const matches = processedContent.match(pattern);
      if (matches) {
        processedContent = processedContent.replace(pattern, SAFE_PLACEHOLDERS.internalId);
        redactionsApplied.push(`INTERNAL_ID_PATTERN_${index + 1}`);
        auditLog.push(`Redacted ${matches.length} internal ID(s) using pattern ${index + 1}`);
      }
    });
  }
  
  // Determine compliance status
  let complianceStatus: 'COMPLIANT' | 'WARNING' | 'VIOLATION' = 'COMPLIANT';
  
  if (redactionsApplied.length > 0) {
    complianceStatus = 'WARNING';
    auditLog.push(`Redactions applied: ${redactionsApplied.length} types`);
  }
  
  // Check for any remaining sensitive patterns that might have been missed
  const remainingSensitive = checkForRemainingSensitiveContent(processedContent);
  if (remainingSensitive.length > 0) {
    complianceStatus = 'VIOLATION';
    auditLog.push(`WARNING: Potential sensitive content still detected: ${remainingSensitive.join(', ')}`);
  }
  
  auditLog.push(`Security compliance check completed with status: ${complianceStatus}`);
  
  return {
    content: processedContent,
    redactionsApplied,
    complianceStatus,
    auditLog
  };
}

/**
 * Check for any remaining sensitive content that might need additional redaction
 */
function checkForRemainingSensitiveContent(content: string): string[] {
  const issues: string[] = [];
  
  // Check for potentially missed patterns
  if (content.match(/[a-zA-Z0-9]{40,}/)) {
    issues.push('LONG_ALPHANUMERIC_STRING');
  }
  
  if (content.match(/\b[A-Z_]{3,}_KEY\b/)) {
    issues.push('POTENTIAL_KEY_REFERENCE');
  }
  
  if (content.match(/\b[A-Z_]{3,}_TOKEN\b/)) {
    issues.push('POTENTIAL_TOKEN_REFERENCE');
  }
  
  if (content.match(/localhost:\d+/)) {
    issues.push('LOCAL_ENDPOINT');
  }
  
  return issues;
}

/**
 * Create a secure reasoning prompt that ensures compliance
 */
export function createSecureReasoningPrompt(userInput: string): string {
  const securePrompt = `
You are the reasoning engine for ARCANOS. Your role is to provide deep analysis, structured plans, and problem-solving steps while maintaining strict security and compliance standards.

SECURITY REQUIREMENTS (CRITICAL):
1. Do NOT generate, expose, or guess real API keys, tokens, passwords, access credentials, or any sensitive authentication strings
2. If your reasoning requires an example of such data, replace it with a safe placeholder in the format: <KEY_REDACTED> or <TOKEN_REDACTED>
3. Do NOT output internal file paths, environment variables, or proprietary code from ARCANOS's backend unless explicitly requested by ARCANOS
4. When giving technical examples, use fictional or generic identifiers that cannot be mistaken for live credentials
5. Always assume your output will be logged, audited, and stored. Write with compliance and confidentiality in mind
6. Focus on reasoning and structured solutions — ARCANOS will handle execution, tone, and delivery

RESPONSE REQUIREMENTS:
- Provide structured, clear analysis free of any confidential or security-sensitive strings
- Use generic examples and fictional identifiers for technical explanations
- Focus on problem-solving methodology rather than exposing implementation details
- Ensure all recommendations are actionable but do not reveal sensitive system information

User Request: ${userInput}

Provide your analysis following the security requirements above:`;
  
  return securePrompt;
}

/**
 * Create structured reasoning response that complies with security requirements
 */
export function createStructuredSecureResponse(
  analysis: string,
  userInput: string
): { structuredResponse: string; complianceCheck: RedactionResult } {
  
  // Apply security compliance to the analysis
  const complianceCheck = applySecurityCompliance(analysis);
  
  // Create structured response format
  const structuredResponse = `
🧠 ARCANOS REASONING ENGINE ANALYSIS
═══════════════════════════════════

📋 REQUEST SUMMARY
${createSafeInputSummary(userInput)}

🔍 STRUCTURED ANALYSIS
${complianceCheck.content}

📊 COMPLIANCE STATUS
Status: ${complianceCheck.complianceStatus}
Security Measures Applied: ${complianceCheck.redactionsApplied.length > 0 ? complianceCheck.redactionsApplied.join(', ') : 'None required'}

🎯 STRUCTURED RECOMMENDATIONS
The analysis above provides problem-solving methodology while maintaining security compliance.
All sensitive information has been redacted using safe placeholders as required.

Note: This analysis is designed for audit compliance and confidentiality standards.
`;

  return { structuredResponse, complianceCheck };
}

/**
 * Create a safe summary of user input without exposing sensitive details
 */
function createSafeInputSummary(userInput: string): string {
  const inputLength = userInput.length;
  const wordCount = userInput.split(/\s+/).length;
  
  return `Request received (${inputLength} characters, ${wordCount} words) - Content processed with security compliance`;
}

/**
 * Log security compliance audit trail
 */
export function logSecurityAudit(auditData: RedactionResult, requestId: string): void {
  const auditEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    complianceStatus: auditData.complianceStatus,
    redactionsApplied: auditData.redactionsApplied,
    auditLog: auditData.auditLog
  };
  
  console.log(`[🔒 SECURITY AUDIT] ${JSON.stringify(auditEntry)}`);
}

export default {
  applySecurityCompliance,
  createSecureReasoningPrompt,
  createStructuredSecureResponse,
  logSecurityAudit,
  DEFAULT_SECURITY_CONFIG
};