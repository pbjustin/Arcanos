import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { parseDagNodeJobInput } from '../src/jobs/jobSchema.js';
import { actionDefinitionSchema } from '../src/shared/types/actionPlan.js';
import { aiRequestSchema } from '../src/shared/types/dto.js';
import { formatZodIssues } from '../src/shared/validation/zodIssues.js';
import { legacyInteger } from '../src/shared/validation/zodNumberChecks.js';

describe('patched Zod preserves established integer admission', () => {
  const integer = z.number().check(...legacyInteger());

  it.each([0, -1, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, -(Number.MAX_SAFE_INTEGER + 1), 1e100])(
    'accepts the existing finite integer %s without adding safe-integer bounds', value => {
      expect(integer.parse(value)).toBe(value);
    },
  );

  it('emits integer JSON Schema without new minimum or maximum constraints', () => {
    const schema = z.toJSONSchema(integer);
    expect(schema.type).toBe('integer');
    expect(schema).not.toHaveProperty('minimum');
    expect(schema).not.toHaveProperty('maximum');
    expect(z.toJSONSchema(integer.min(0).max(100))).toMatchObject({
      type: 'integer', minimum: 0, maximum: 100,
    });
  });

  it('rejects fractional numbers with the existing public integer issue', () => {
    const result = integer.safeParse(1.5);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodIssues(result.error, 1.5, integer)).toEqual([{
        code: 'invalid_type', expected: 'integer', received: 'float',
        message: 'Expected integer, received float', path: [],
      }]);
    }
  });

  it('preserves number coercion, explicit ranges, and explicit safe-integer policy', () => {
    const coerce = z.coerce.number().check(...legacyInteger());
    expect(coerce.parse(String(Number.MAX_SAFE_INTEGER + 1))).toBe(Number.MAX_SAFE_INTEGER + 1);
    expect(coerce.safeParse('1.5').success).toBe(false);
    expect(integer.min(0).safeParse(-1).success).toBe(false);
    expect(integer.max(100).safeParse(101).success).toBe(false);
    expect(integer.safe().safeParse(Number.MAX_SAFE_INTEGER + 1).success).toBe(false);
  });

  it('continues object refinement after a float to preserve the missing-prompt issue', () => {
    const input = { maxWords: 0.5 };
    const result = aiRequestSchema.safeParse(input);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(formatZodIssues(result.error, input, aiRequestSchema)).toEqual([
        {
          code: 'invalid_type', expected: 'integer', received: 'float',
          message: 'Expected integer, received float', path: ['maxWords'],
        },
        {
          code: 'custom', path: ['prompt'],
          message: 'Request must include one of prompt, userInput, content, text, or query fields',
        },
      ]);
    }
  });

  it('retains the accepted unbounded integer range in persisted DAG and ActionPlan schemas', () => {
    const value = Number.MAX_SAFE_INTEGER + 1;
    const dag = parseDagNodeJobInput({
      dagId: 'dag-1', node: { id: 'node-1', type: 'task', executionKey: 'test.task' }, depth: value,
    });
    expect(dag).toMatchObject({ ok: true, value: { depth: value } });
    expect(actionDefinitionSchema.parse({ agent_id: 'agent-1', capability: 'test', timeout_ms: value }).timeout_ms)
      .toBe(value);
  });
});
