import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import { legacyDatetime, legacyUuid, utf16MaxLength, utf16MinLength } from '../src/shared/validation/zodStringChecks.js';

describe('patched Zod preserves established string admission', () => {
  it('retains a non-ASCII minimum and its JSON Schema bound', () => {
    const schema = z.string().check(...utf16MinLength(8)).max(10).check(utf16MaxLength(10));
    expect(schema.parse('😀😀😀😀')).toBe('😀😀😀😀');
    expect(schema.safeParse('😀😀😀').success).toBe(false);
    expect(z.toJSONSchema(schema)).toMatchObject({ minLength: 8, maxLength: 10 });
  });
  it('retains the UTF-16 cap and emits one issue without changing JSON Schema bounds', () => {
    const schema = z.string().max(3).check(utf16MaxLength(3));
    expect(schema.parse('a😀')).toBe('a😀');
    for (const value of ['😀😀', 'abcd']) {
      const result = schema.safeParse(value);
      expect(result.success).toBe(false);
      if (!result.success) expect(result.error.issues).toHaveLength(1);
    }
    expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string', maxLength: 3 });
  });

  it('retains an explicit maximum-length message for astral text', () => {
    const schema = z.string().max(1, 'Existing cap').check(utf16MaxLength(1, 'Existing cap'));
    const result = schema.safeParse('😀');
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0].message).toBe('Existing cap');
  });

  it.each(['00000000-0000-0000-0000-000000000000', 'ABCDEFAB-CDEF-0000-0000-ABCDEFABCDEF'])(
    'retains previously accepted UUID shape %s', value => {
      const schema = z.string().check(legacyUuid());
      expect(schema.parse(value)).toBe(value);
      expect(schema.safeParse('bad-uuid').success).toBe(false);
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string', format: 'uuid' });
    }
  );

  it.each(['2026-10-24T01:00Z', '2026-10-24T01:00:00Z', '2024-02-29T01:00:00.123Z'])(
    'retains supported UTC timestamp %s', value => {
      const schema = z.string().check(legacyDatetime());
      expect(schema.parse(value)).toBe(value);
      expect(z.toJSONSchema(schema)).toMatchObject({ type: 'string', format: 'date-time' });
    }
  );

  it('retains offset opt-in and calendar/time rejection', () => {
    const utc = z.string().check(legacyDatetime());
    const offset = z.string().check(legacyDatetime({ offset: true }));
    for (const value of ['2026-10-24T01:00+0530', '2026-10-24T01:00:00+05:30']) {
      expect(offset.parse(value)).toBe(value);
      expect(utc.safeParse(value).success).toBe(false);
    }
    for (const value of ['2026-02-29T01:00Z', '2026-10-24T25:00Z', '2026-10-24T01:60Z', '2026-10-24T01:00']) {
      expect(offset.safeParse(value).success).toBe(false);
    }
  });
});
