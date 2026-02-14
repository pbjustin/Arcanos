import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  AiOutputBoundaryError,
  assertDeterministicConfirmation,
  parseModelOutputWithSchema,
  parseToolArgumentsWithSchema
} from '../src/services/safety/aiOutputBoundary.js';

describe('ai output trust boundary', () => {
  it('rejects malformed JSON when fallback is disabled', () => {
    expect(() =>
      parseModelOutputWithSchema('{not-json}', z.object({ ok: z.boolean() }), {
        source: 'tests/ai-output-boundary.invalid-json',
        allowFallback: false
      })
    ).toThrow(AiOutputBoundaryError);
  });

  it('uses explicit fallback for schema mismatch when allowed', () => {
    const parsed = parseModelOutputWithSchema('{"ok":"nope"}', z.object({ ok: z.boolean() }), {
      source: 'tests/ai-output-boundary.fallback',
      allowFallback: true,
      fallbackValue: { ok: false }
    });

    expect(parsed).toEqual({ ok: false });
  });

  it('rejects invalid tool arguments that fail schema checks', () => {
    expect(() =>
      parseToolArgumentsWithSchema(
        '{"command":""}',
        z.object({
          command: z.string().trim().min(1)
        }),
        'tests/ai-output-boundary.tool-args'
      )
    ).toThrow(AiOutputBoundaryError);
  });

  it('requires deterministic confirmation for irreversible actions', () => {
    expect(() =>
      assertDeterministicConfirmation({
        action: 'run_command',
        deterministicConfirmation: false,
        source: 'tests/ai-output-boundary.confirmation-missing'
      })
    ).toThrow(AiOutputBoundaryError);

    expect(() =>
      assertDeterministicConfirmation({
        action: 'run_command',
        deterministicConfirmation: true,
        confirmationToken: 'confirm-token-1',
        source: 'tests/ai-output-boundary.confirmation-valid'
      })
    ).not.toThrow();
  });
});
