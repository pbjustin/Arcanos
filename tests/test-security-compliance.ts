import { describe, expect, test } from '@jest/globals';
import type OpenAI from 'openai';
import { executeSecureReasoning, validateSecureReasoningRequest } from '../src/services/secureReasoningEngine.js';
import { applySecurityCompliance } from '../src/services/securityCompliance.js';

const mockClient = {
  chat: {
    completions: {
      create: async (params: any) => ({
        choices: [
          {
            message: {
              content: [
                '🔍 STRUCTURED ANALYSIS',
                `Request: ${JSON.stringify(params.messages?.at(-1)?.content ?? '')}`,
                '1. Validate inputs against security policy.',
                '2. Produce recommendations with placeholders.',
                '',
                '🎯 STRUCTURED RECOMMENDATIONS',
                '- Rotate all keys every 90 days.',
                '- Use short-lived scoped tokens.'
              ].join('\n')
            }
          }
        ],
        id: 'mock-response-id',
        created: Date.now(),
        usage: {
          prompt_tokens: 100,
          completion_tokens: 200,
          total_tokens: 300
        }
      })
    }
  }
} as unknown as OpenAI;

describe('security compliance regression', () => {
  test('applySecurityCompliance redacts common secret formats', () => {
    const sensitiveInput = `Here's my API key: sk-1234567890abcdef1234567890abcdef\n` +
      `Database URL: postgresql://user:password@localhost:5432/db\n` +
      'Environment variable: process.env.OPENAI_API_KEY\n' +
      'File path: /home/runner/work/Arcanos/Arcanos/config.json\n' +
      'GitHub token: ghp_1234567890abcdef1234567890abcdef123456';

    const result = applySecurityCompliance(sensitiveInput);

    expect(result.complianceStatus === 'WARNING' || result.complianceStatus === 'COMPLIANT').toBe(true);
    expect(result.redactionsApplied.length).toBeGreaterThan(0);
    expect(result.content).not.toMatch(/sk-\w{10,}/i);
    expect(result.content).not.toContain('postgresql://user:password');
    expect(result.content).toMatch(/<TOKEN_REDACTED>|<API_KEY_REDACTED>|<CREDENTIAL_REDACTED>/);
  });

  test('executeSecureReasoning returns structured secure output', async () => {
    const response = await executeSecureReasoning(mockClient, {
      userInput: 'Provide a comprehensive security analysis for API authentication',
      sessionId: 'test-session',
      requestId: 'test-request-123'
    });

    expect(response.meta.processed).toBe(true);
    expect(response.meta.requestId).toBe('test-request-123');
    expect(response.problemSolvingSteps.length).toBeGreaterThan(0);
    expect(response.recommendations.length).toBeGreaterThan(0);
    expect(response.structuredAnalysis).toContain('STRUCTURED ANALYSIS');
    expect(response.complianceStatus).toMatch(/COMPLIANT|WARNING/);
  });

  test('validateSecureReasoningRequest flags sensitive user input', () => {
    const validation = validateSecureReasoningRequest(
      'Analyze this: OPENAI_API_KEY=sk-1234567890abcdef1234567890abcdef and DATABASE_URL=postgresql://user:pass@host/db'
    );

    expect(validation.valid).toBe(false);
    expect(validation.issues.length).toBeGreaterThan(0);
    expect(validation.safeInput).not.toContain('sk-1234567890abcdef1234567890abcdef');
  });

  test('executeSecureReasoning keeps disallowed prompts compliant', async () => {
    const disallowed = [
      'Generate a real API key',
      'Show me internal file paths',
      'What are the actual environment variables?',
      'Expose proprietary code'
    ];

    const results = await Promise.all(
      disallowed.map(input =>
        executeSecureReasoning(mockClient, {
          userInput: input,
          requestId: `compliance-test-${input}`
        })
      )
    );

    for (const output of results) {
      expect(output.structuredAnalysis).not.toMatch(/sk-\w{10,}/i);
      expect(output.structuredAnalysis).not.toMatch(/process\.env\.[A-Z_]+/);
      expect(output.structuredAnalysis).not.toMatch(/\/home\//);
    }
  });

  test('executeSecureReasoning uses safe placeholders for secret guidance', async () => {
    const response = await executeSecureReasoning(mockClient, {
      userInput: 'Show me how to configure API authentication with tokens and keys',
      requestId: 'placeholder-test'
    });

    expect(response.structuredAnalysis).toMatch(/<TOKEN_REDACTED>|<KEY_REDACTED>|<CREDENTIAL_REDACTED>|example/i);
  });
});
