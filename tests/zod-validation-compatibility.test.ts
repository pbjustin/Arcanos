import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { formatZodErrorMessage, formatZodIssues } from '../src/shared/validation/zodIssues.js';
import { legacyUuid } from '../src/shared/validation/zodStringChecks.js';

// Expected envelopes were captured from the pre-migration Zod 3.25.76 package.
// Keep them literal so this regression suite never imports the old runtime.
const fixtures: Array<{ name: string; schema: z.ZodType; input: unknown; expectedMessage: string }> = [
  { name: "required property", schema: z.object({ name: z.string() }), input: {}, expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"undefined\",\n    \"path\": [\n      \"name\"\n    ],\n    \"message\": \"Required\"\n  }\n]" },
  { name: "wrong primitive type", schema: z.object({ count: z.number() }), input: { count: 'x' }, expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"string\",\n    \"path\": [\n      \"count\"\n    ],\n    \"message\": \"Expected number, received string\"\n  }\n]" },
  { name: "null primitive", schema: z.string(), input: null, expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"string\",\n    \"received\": \"null\",\n    \"path\": [],\n    \"message\": \"Expected string, received null\"\n  }\n]" },
  { name: "NaN", schema: z.number(), input: NaN, expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"nan\",\n    \"path\": [],\n    \"message\": \"Expected number, received nan\"\n  }\n]" },
  { name: "coerced NaN", schema: z.coerce.number(), input: 'abc', expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"number\",\n    \"received\": \"nan\",\n    \"path\": [],\n    \"message\": \"Expected number, received nan\"\n  }\n]" },
  { name: "integer", schema: z.number().int(), input: 1.5, expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"integer\",\n    \"received\": \"float\",\n    \"message\": \"Expected integer, received float\",\n    \"path\": []\n  }\n]" },
  { name: "coerced integer", schema: z.coerce.number().int(), input: '1.5', expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"integer\",\n    \"received\": \"float\",\n    \"message\": \"Expected integer, received float\",\n    \"path\": []\n  }\n]" },
  { name: "string minimum", schema: z.string().min(2), input: 'x', expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"String must contain at least 2 character(s)\",\n    \"path\": []\n  }\n]" },
  { name: "string maximum", schema: z.string().max(2), input: 'xxx', expectedMessage: "[\n  {\n    \"code\": \"too_big\",\n    \"maximum\": 2,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"String must contain at most 2 character(s)\",\n    \"path\": []\n  }\n]" },
  { name: "exact string length", schema: z.string().length(2), input: 'x', expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"exact\": true,\n    \"message\": \"String must contain exactly 2 character(s)\",\n    \"path\": []\n  }\n]" },
  { name: "number minimum", schema: z.number().min(2), input: 1, expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"type\": \"number\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"Number must be greater than or equal to 2\",\n    \"path\": []\n  }\n]" },
  { name: "positive number", schema: z.number().positive(), input: 0, expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 0,\n    \"type\": \"number\",\n    \"inclusive\": false,\n    \"exact\": false,\n    \"message\": \"Number must be greater than 0\",\n    \"path\": []\n  }\n]" },
  { name: "number maximum", schema: z.number().max(2), input: 3, expectedMessage: "[\n  {\n    \"code\": \"too_big\",\n    \"maximum\": 2,\n    \"type\": \"number\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"Number must be less than or equal to 2\",\n    \"path\": []\n  }\n]" },
  { name: "array minimum", schema: z.array(z.string()).min(2), input: ['x'], expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"type\": \"array\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"Array must contain at least 2 element(s)\",\n    \"path\": []\n  }\n]" },
  { name: "array maximum", schema: z.array(z.string()).max(1), input: ['x', 'y'], expectedMessage: "[\n  {\n    \"code\": \"too_big\",\n    \"maximum\": 1,\n    \"type\": \"array\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"Array must contain at most 1 element(s)\",\n    \"path\": []\n  }\n]" },
  { name: "enum", schema: z.enum(['one', 'two']), input: 'bad', expectedMessage: "[\n  {\n    \"received\": \"bad\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n      \"one\",\n      \"two\"\n    ],\n    \"path\": [],\n    \"message\": \"Invalid enum value. Expected 'one' | 'two', received 'bad'\"\n  }\n]" },
  { name: "required enum", schema: z.enum(['one', 'two']), input: undefined, expectedMessage: "[\n  {\n    \"expected\": \"'one' | 'two'\",\n    \"received\": \"undefined\",\n    \"code\": \"invalid_type\",\n    \"path\": [],\n    \"message\": \"Required\"\n  }\n]" },
  { name: "null enum", schema: z.enum(['one', 'two']), input: null, expectedMessage: "[\n  {\n    \"expected\": \"'one' | 'two'\",\n    \"received\": \"null\",\n    \"code\": \"invalid_type\",\n    \"path\": [],\n    \"message\": \"Expected 'one' | 'two', received null\"\n  }\n]" },
  { name: "numeric enum input", schema: z.enum(['one', 'two']), input: 42, expectedMessage: "[\n  {\n    \"expected\": \"'one' | 'two'\",\n    \"received\": \"number\",\n    \"code\": \"invalid_type\",\n    \"path\": [],\n    \"message\": \"Expected 'one' | 'two', received number\"\n  }\n]" },
  { name: "singleton enum", schema: z.enum(['one']), input: 'bad', expectedMessage: "[\n  {\n    \"received\": \"bad\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n      \"one\"\n    ],\n    \"path\": [],\n    \"message\": \"Invalid enum value. Expected 'one', received 'bad'\"\n  }\n]" },
  { name: "literal", schema: z.literal('one'), input: 'bad', expectedMessage: "[\n  {\n    \"received\": \"bad\",\n    \"code\": \"invalid_literal\",\n    \"expected\": \"one\",\n    \"path\": [],\n    \"message\": \"Invalid literal value, expected \\\"one\\\"\"\n  }\n]" },
  { name: "required literal", schema: z.literal(true), input: undefined, expectedMessage: "[\n  {\n    \"code\": \"invalid_literal\",\n    \"expected\": true,\n    \"path\": [],\n    \"message\": \"Invalid literal value, expected true\"\n  }\n]" },
  { name: "discriminated union", schema: z.discriminatedUnion('contractVersion', [z.object({ contractVersion: z.literal('v1') }), z.object({ contractVersion: z.literal('v2') })]), input: { contractVersion: 'v3' }, expectedMessage: "[\n  {\n    \"code\": \"invalid_union_discriminator\",\n    \"options\": [\n      \"v1\",\n      \"v2\"\n    ],\n    \"path\": [\n      \"contractVersion\"\n    ],\n    \"message\": \"Invalid discriminator value. Expected 'v1' | 'v2'\"\n  }\n]" },
  { name: "nested union", schema: z.object({ choice: z.union([z.object({ name: z.string() }), z.object({ count: z.number() })]) }), input: { choice: { name: 4, count: 'x' } }, expectedMessage: "[\n  {\n    \"code\": \"invalid_union\",\n    \"unionErrors\": [\n      {\n        \"issues\": [\n          {\n            \"code\": \"invalid_type\",\n            \"expected\": \"string\",\n            \"received\": \"number\",\n            \"path\": [\n              \"choice\",\n              \"name\"\n            ],\n            \"message\": \"Expected string, received number\"\n          }\n        ],\n        \"name\": \"ZodError\"\n      },\n      {\n        \"issues\": [\n          {\n            \"code\": \"invalid_type\",\n            \"expected\": \"number\",\n            \"received\": \"string\",\n            \"path\": [\n              \"choice\",\n              \"count\"\n            ],\n            \"message\": \"Expected number, received string\"\n          }\n        ],\n        \"name\": \"ZodError\"\n      }\n    ],\n    \"path\": [\n      \"choice\"\n    ],\n    \"message\": \"Invalid input\"\n  }\n]" },
  { name: "strict object", schema: z.object({ name: z.string() }).strict(), input: { name: 'a', extra: 1, other: 2 }, expectedMessage: "[\n  {\n    \"code\": \"unrecognized_keys\",\n    \"keys\": [\n      \"extra\",\n      \"other\"\n    ],\n    \"path\": [],\n    \"message\": \"Unrecognized key(s) in object: 'extra', 'other'\"\n  }\n]" },
  { name: "UUID", schema: z.string().uuid(), input: 'x', expectedMessage: "[\n  {\n    \"validation\": \"uuid\",\n    \"code\": \"invalid_string\",\n    \"message\": \"Invalid uuid\",\n    \"path\": []\n  }\n]" },
  { name: "URL", schema: z.string().url(), input: 'x', expectedMessage: "[\n  {\n    \"validation\": \"url\",\n    \"code\": \"invalid_string\",\n    \"message\": \"Invalid url\",\n    \"path\": []\n  }\n]" },
  { name: "datetime", schema: z.string().datetime(), input: 'x', expectedMessage: "[\n  {\n    \"code\": \"invalid_string\",\n    \"validation\": \"datetime\",\n    \"message\": \"Invalid datetime\",\n    \"path\": []\n  }\n]" },
  { name: "date", schema: z.string().date(), input: 'x', expectedMessage: "[\n  {\n    \"code\": \"invalid_string\",\n    \"validation\": \"date\",\n    \"message\": \"Invalid date\",\n    \"path\": []\n  }\n]" },
  { name: "regex", schema: z.string().regex(/x/), input: 'a', expectedMessage: "[\n  {\n    \"validation\": \"regex\",\n    \"code\": \"invalid_string\",\n    \"message\": \"Invalid\",\n    \"path\": []\n  }\n]" },
  { name: "custom refinement", schema: z.string().refine(() => false, 'Known domain error'), input: 'a', expectedMessage: "[\n  {\n    \"code\": \"custom\",\n    \"message\": \"Known domain error\",\n    \"path\": []\n  }\n]" },
  { name: "custom bound message", schema: z.string().min(2, 'A name is required.'), input: 'x', expectedMessage: "[\n  {\n    \"code\": \"too_small\",\n    \"minimum\": 2,\n    \"type\": \"string\",\n    \"inclusive\": true,\n    \"exact\": false,\n    \"message\": \"A name is required.\",\n    \"path\": []\n  }\n]" },
  { name: "nested wrapped enum", schema: z.object({ items: z.array(z.object({ mode: z.enum(['fast']).default('fast').optional() })) }), input: { items: [{ mode: 'bad' }] }, expectedMessage: "[\n  {\n    \"received\": \"bad\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n      \"fast\"\n    ],\n    \"path\": [\n      \"items\",\n      0,\n      \"mode\"\n    ],\n    \"message\": \"Invalid enum value. Expected 'fast', received 'bad'\"\n  }\n]" },
  { name: "record type", schema: z.record(z.string(), z.unknown()), input: [], expectedMessage: "[\n  {\n    \"code\": \"invalid_type\",\n    \"expected\": \"object\",\n    \"received\": \"array\",\n    \"path\": [],\n    \"message\": \"Expected object, received array\"\n  }\n]" },
  { name: "nested record value", schema: z.object({ data: z.record(z.string(), z.enum(['on'])) }), input: { data: { feature: 'bad' } }, expectedMessage: "[\n  {\n    \"received\": \"bad\",\n    \"code\": \"invalid_enum_value\",\n    \"options\": [\n      \"on\"\n    ],\n    \"path\": [\n      \"data\",\n      \"feature\"\n    ],\n    \"message\": \"Invalid enum value. Expected 'on', received 'bad'\"\n  }\n]" },
];

describe('public Zod validation compatibility', () => {
  it('preserves the UUID envelope when the legacy UUID check reports guid format', () => {
    const schema = z.string().check(legacyUuid());
    const parsed = schema.safeParse('bad');
    if (parsed.success) throw new Error('Expected invalid UUID input');
    const baseline = fixtures.find(fixture => fixture.name === 'UUID');
    expect(formatZodErrorMessage(parsed.error, 'bad', schema)).toBe(baseline?.expectedMessage);
  });

  it.each(fixtures)('preserves the prior $name envelope', ({ schema, input, expectedMessage }) => {
    const parsed = schema.safeParse(input);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('Expected invalid fixture input');
    const before = JSON.stringify(parsed.error.issues);
    expect(formatZodIssues(parsed.error, input, schema)).toEqual(JSON.parse(expectedMessage));
    expect(formatZodErrorMessage(parsed.error, input, schema)).toBe(expectedMessage);
    expect(JSON.stringify(parsed.error.issues)).toBe(before);
  });

  it('reads only own data properties while rendering paths', () => {
    let getterCalls = 0;
    const inherited = Object.create({ get target() { getterCalls += 1; return { name: 'sensitive' }; } });
    const accessor = Object.defineProperty({}, 'target', {
      get() { getterCalls += 1; return { name: 'sensitive' }; }
    });
    const error: Pick<z.ZodError, 'issues'> = { issues: [{
      code: 'invalid_type', expected: 'string', path: ['target', 'name'],
      message: 'Invalid input: expected string, received undefined'
    }] };
    for (const input of [inherited, accessor]) {
      expect(formatZodIssues(error, input)).toEqual([{
        code: 'invalid_type', expected: 'string', received: 'undefined',
        path: ['target', 'name'], message: 'Required'
      }]);
      expect(formatZodErrorMessage(error, input)).not.toContain('sensitive');
    }
    expect(getterCalls).toBe(0);
  });

  it('does not copy arbitrary input or reportInput metadata into issues', () => {
    const input = { name: 42, privateValue: 'sensitive' };
    const schema = z.object({ name: z.string() });
    const parsed = schema.safeParse(input, { reportInput: true });
    if (parsed.success) throw new Error('Expected invalid fixture input');
    const rendered = formatZodErrorMessage(parsed.error, input, schema);
    expect(rendered).not.toContain('sensitive');
    expect(rendered).not.toContain('input');
    expect(JSON.parse(rendered)).toEqual([{
      code: 'invalid_type', expected: 'string', received: 'number',
      path: ['name'], message: 'Expected string, received number'
    }]);
  });

  it('retains explicit defaults and omitted optional properties', () => {
    const schema = z.object({
      count: z.number().int().optional().default(2),
      metadata: z.record(z.string(), z.unknown()).optional(),
      value: z.unknown().optional()
    });
    expect(schema.parse({})).toEqual({ count: 2 });
    expect(schema.parse({ count: 0, value: null })).toEqual({ count: 0, value: null });
  });

  it('recognizes enum schemas through an input transform pipe', () => {
    const schema = z.enum(['fast']).transform(value => value);
    const parsed = schema.safeParse('bad');
    if (parsed.success) throw new Error('Expected invalid fixture input');
    expect(formatZodIssues(parsed.error, 'bad', schema)[0]).toMatchObject({
      code: 'invalid_enum_value', options: ['fast'], received: 'bad',
      message: "Invalid enum value. Expected 'fast', received 'bad'"
    });
  });
});
