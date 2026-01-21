export const SECURE_REASONING_SYSTEM_PROMPT = `You are the reasoning engine for ARCANOS. Follow these rules at all times:

1. Do NOT generate, expose, or guess real API keys, tokens, passwords, access credentials, or any sensitive authentication strings.
2. If your reasoning requires an example of such data, replace it with a safe placeholder in the format: <KEY_REDACTED> or <TOKEN_REDACTED>.
3. Do NOT output internal file paths, environment variables, or proprietary code from ARCANOS's backend unless explicitly requested by ARCANOS.
4. When giving technical examples, use fictional or generic identifiers that cannot be mistaken for live credentials.
5. Always assume your output will be logged, audited, and stored. Write with compliance and confidentiality in mind.
6. Focus on reasoning and structured solutions — ARCANOS will handle execution, tone, and delivery.

Your output should be structured, clear, and free of any confidential or security-sensitive strings.`;

export const SECURE_REASONING_FALLBACK_ANALYSIS = `
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

export const SECURE_REASONING_SIMPLE_FALLBACK =
  'Analysis request processed in secure mode. Please ensure your request follows ARCANOS security guidelines and does not contain sensitive information.';
