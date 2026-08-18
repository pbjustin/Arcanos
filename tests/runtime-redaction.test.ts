import { describe, expect, it } from '@jest/globals';

import { redactSensitive } from '@arcanos/runtime/redaction';

function ownKey(record: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

describe('shared runtime redaction', () => {
  it('redacts the complete Backstage Notion universe-page mapping', () => {
    const mapping = '{"my-universe-2k26":["11111111-1111-4111-8111-111111111111"]}';

    expect(redactSensitive({
      ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON: mapping,
      ordinary: 'visible',
    })).toEqual({
      ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON: '[REDACTED]',
      ordinary: 'visible',
    });
  });

  it('replaces credential-shaped property names without dropping their values', () => {
    const secretBearingKey = [
      'sk',
      'sharedredactionplaceholder123456',
    ].join('-');
    const input = {
      [secretBearingKey]: {
        nested: 'ordinary value',
      },
      ordinary: 'visible',
    };

    const sanitized = redactSensitive(input);
    const rendered = JSON.stringify(sanitized);

    expect(sanitized).toEqual({
      '[REDACTED_KEY_1]': {
        nested: 'ordinary value',
      },
      ordinary: 'visible',
    });
    expect(rendered).not.toContain(secretBearingKey);
    expect(input).toEqual({
      [secretBearingKey]: {
        nested: 'ordinary value',
      },
      ordinary: 'visible',
    });
  });

  it('reserves caller-provided marker keys before allocating opaque replacements', () => {
    const firstSecretKey = [
      'sk',
      'firstsharedplaceholder123456',
    ].join('-');
    const secondSecretKey = [
      'sk',
      'secondsharedplaceholder123456',
    ].join('-');
    const input = Object.fromEntries([
      [firstSecretKey, 'first value'],
      ['[REDACTED_KEY_1]', 'literal first marker'],
      [secondSecretKey, 'second value'],
      ['[REDACTED_KEY_3]', 'literal third marker'],
    ]);

    expect(redactSensitive(input)).toEqual({
      '[REDACTED_KEY_2]': 'first value',
      '[REDACTED_KEY_1]': 'literal first marker',
      '[REDACTED_KEY_4]': 'second value',
      '[REDACTED_KEY_3]': 'literal third marker',
    });
  });

  it('projects prototype-sensitive names as safe own marker properties', () => {
    const input = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"constructor value","prototype":"prototype value","ordinary":"visible"}'
    ) as Record<string, unknown>;

    const sanitized = redactSensitive(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(sanitized)).toBe(Object.prototype);
    expect(ownKey(sanitized, '__proto__')).toBe(false);
    expect(ownKey(sanitized, 'constructor')).toBe(false);
    expect(ownKey(sanitized, 'prototype')).toBe(false);
    expect(sanitized).toEqual({
      '[REDACTED_KEY_1]': {
        polluted: true,
      },
      '[REDACTED_KEY_2]': 'constructor value',
      '[REDACTED_KEY_3]': 'prototype value',
      ordinary: 'visible',
    });
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it('uses original keys for value redaction before projecting unsafe names', () => {
    const unsafePasswordKey = [
      'password',
      'sk',
      'valuesentinelplaceholder123456',
    ].join('-');
    const sensitiveValue = ['also', 'must', 'not', 'survive'].join(' ');

    expect(
      redactSensitive({
        [unsafePasswordKey]: 'must not survive',
        token: sensitiveValue,
      })
    ).toEqual({
      '[REDACTED_KEY_1]': '[REDACTED]',
      token: '[REDACTED]',
    });
  });

  it('keeps near-match prototype names and ordinary insertion order unchanged', () => {
    const input = {
      constructorName: 'constructor name',
      prototypeVersion: 'prototype version',
      __proto__suffix: 'suffix value',
      Constructor: 'case-sensitive constructor',
      Prototype: 'case-sensitive prototype',
      __PROTO__: 'case-sensitive proto',
      ordinary: 'visible',
    };

    expect(redactSensitive(input)).toEqual(input);
    expect(Object.keys(redactSensitive(input) as object)).toEqual(
      Object.keys(input)
    );
  });

  it('preserves the existing enumerable own-property projection semantics', () => {
    const symbolKey = Symbol('ignored');
    let getterReads = 0;
    const input = Object.defineProperties(
      {
        [symbolKey]: 'symbol value',
      },
      {
        visible: {
          enumerable: true,
          get: () => {
            getterReads += 1;
            return 'getter value';
          },
        },
        hidden: {
          enumerable: false,
          value: 'hidden value',
        },
      }
    );

    const sanitized = redactSensitive(input) as Record<string, unknown>;

    expect(getterReads).toBe(1);
    expect(sanitized).toEqual({
      visible: 'getter value',
    });
    expect(Reflect.ownKeys(sanitized)).toEqual(['visible']);
    expect(Object.getOwnPropertyDescriptor(sanitized, 'visible')).toEqual({
      configurable: true,
      enumerable: true,
      value: 'getter value',
      writable: true,
    });
  });
});
