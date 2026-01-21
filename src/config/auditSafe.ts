export const AUDIT_SAFE_OVERRIDE_PATTERNS = [
  'ARCANOS_OVERRIDE_AUDIT_SAFE',
  'override audit safe',
  'disable audit mode',
  'emergency override'
];

export const AUDIT_SAFE_SENSITIVE_PATTERNS = [
  'password',
  'credential',
  'secret',
  'private key',
  'confidential',
  'classified',
  'personal information'
];

export const AUDIT_SAFE_NON_COMPLIANT_PATTERNS = [
  'ignore previous instructions',
  'confidential',
  'classified',
  'bypass audit',
  'disable logging'
];

export const AUDIT_SAFE_MODE_LABEL = 'AUDIT_SAFE_ENABLED';

export const AUDIT_SAFE_SYSTEM_PROMPT_SUFFIX = `[AUDIT-SAFE MODE ACTIVE]
- All responses must be auditable and traceable
- Log all reasoning and decision paths clearly
- Avoid sensitive data exposure in logs
- Maintain professional, compliant language
- Document any external tool or model invocations
- Ensure reproducible decision-making processes

AUDIT REQUIREMENT: Your response will be logged for compliance review.`;

export const AUDIT_SAFE_USER_PROMPT_TEMPLATE = `[AUDIT-SAFE REQUEST]
Timestamp: {{timestamp}}
Mode: ${AUDIT_SAFE_MODE_LABEL}
Request ID: {{requestId}}

{{userPrompt}}

[AUDIT DIRECTIVE: Provide a complete, auditable response with clear reasoning.]`;

export const AUDIT_LINEAGE_TEMPLATE =
  '{{timestamp}} | {{requestId}} | {{endpoint}} | Model:{{modelUsed}} | GPT5:{{gpt5Delegated}} | AuditSafe:{{auditSafeMode}} | Flags:[{{auditFlags}}]\n';
