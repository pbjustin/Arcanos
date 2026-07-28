import { describe, expect, it } from '@jest/globals';

import {
  sanitizeGptAccessPayload,
  sanitizeGptAccessString,
} from '../src/services/gptAccessSanitization.js';

const PROMPT_FIELD_KEYS = [
  'prompt',
  'prompttext',
  'prompt_text',
  'promptpreview',
  'prompt_preview',
  'rawprompt',
  'raw_prompt',
  'normalizedprompt',
  'normalized_prompt',
  'task',
  'taskpreview',
  'task_preview',
  'summarypreview',
  'summary_preview',
  'inputpreview',
  'input_preview',
  'outputpreview',
  'output_preview',
  'messages',
] as const;

const DIAGNOSTIC_FIELD_KEYS = [
  'completion',
  'completiontext',
  'completion_text',
  'completions',
  'providerpayload',
  'provider_payload',
  'providerpayloads',
  'provider_payloads',
  'providerrequest',
  'provider_request',
  'providerresponse',
  'provider_response',
  'providerraw',
  'provider_raw',
] as const;

describe('GPT Access sanitization', () => {
  it('applies every string redaction family without changing surrounding text', () => {
    const fakeJwt = ['eyJtest12345', 'eyJtest67890', 'eyJtest54321'].join('.');
    const sanitized = sanitizeGptAccessString(
      [
        'prefix',
        'Bearer test-access-token-123456',
        'sk-test-placeholder-value',
        'railway_testplaceholder1',
        'postgres://user:pass@host/database',
        fakeJwt,
        'token=test-token-value',
        'email=person@example.com',
        'password=test-password-value',
        'suffix',
      ].join(' ')
    );

    expect(sanitized).toContain('prefix');
    expect(sanitized).toContain('suffix');
    expect(sanitized).toContain('Bearer [REDACTED]');
    expect(sanitized).toContain('[REDACTED_OPENAI_KEY]');
    expect(sanitized).toContain('[REDACTED_RAILWAY_TOKEN]');
    expect(sanitized).toContain('[REDACTED_DATABASE_URL]');
    expect(sanitized).toContain('[REDACTED_JWT]');
    expect(sanitized).toContain('email=[REDACTED]');
    expect(sanitized.match(/\$1=\[REDACTED\]/g)).toHaveLength(2);
    expect(sanitized).not.toContain(fakeJwt);
    expect(sanitized).not.toContain('person@example.com');
  });

  it.each([
    ['bearer minimum', 'bearer testabcd', 'Bearer [REDACTED]'],
    ['bearer below minimum', 'Bearer testabc', 'Bearer testabc'],
    [
      'OpenAI minimum',
      'sk-testabcdefghijkl',
      '[REDACTED_OPENAI_KEY]',
    ],
    ['OpenAI below minimum', 'sk-testabcdefghijk', 'sk-testabcdefghijk'],
    [
      'OpenAI case sensitivity',
      'SK-testabcdefghijkl',
      'SK-testabcdefghijkl',
    ],
    [
      'Railway minimum',
      'railway_testplaceholder1',
      '[REDACTED_RAILWAY_TOKEN]',
    ],
    [
      'Railway short alias',
      'RWYtestplaceholder1',
      '[REDACTED_RAILWAY_TOKEN]',
    ],
    [
      'Railway below minimum',
      'railway_testplaceholder',
      'railway_testplaceholder',
    ],
    [
      'JWT minimum',
      ['eyJtest1234', 'test5678', 'test9012'].join('.'),
      '[REDACTED_JWT]',
    ],
    [
      'JWT short segment',
      'eyJtest1234.test567.test9012',
      'eyJtest1234.test567.test9012',
    ],
    [
      'JWT case sensitivity',
      'EYJtest1234.test5678.test9012',
      'EYJtest1234.test5678.test9012',
    ],
  ])('%s preserves its exact match boundary', (_label, input, expected) => {
    expect(sanitizeGptAccessString(input)).toBe(expected);
  });

  it.each(['postgres', 'postgresql', 'mysql', 'mongodb'])(
    'redacts the %s database URL scheme',
    (scheme) => {
      expect(
        sanitizeGptAccessString(`${scheme}://user:pass@host/database trailing`)
      ).toBe('[REDACTED_DATABASE_URL] trailing');
    }
  );

  it('does not broaden the local database URL rule to Redis', () => {
    expect(
      sanitizeGptAccessString('redis://user:pass@host/database')
    ).toBe('redis://user:pass@host/database');
  });

  it.each([
    'authorization',
    'cookie',
    'set-cookie',
    'apikey',
    'api-key',
    'api_key',
    'token',
    'secret',
    'password',
    'session',
    'sessionid',
    'database_url',
  ])('preserves the legacy generic assignment marker for %s', (key) => {
    expect(
      sanitizeGptAccessString(`${key}=test-placeholder-value`)
    ).toBe('$1=[REDACTED]');
  });

  it('preserves captured email casing and assignment-rule ordering', () => {
    expect(sanitizeGptAccessString('EMAIL=test@example.com')).toBe(
      'EMAIL=[REDACTED]'
    );
    expect(
      sanitizeGptAccessString(
        'Authorization: Bearer test-access-token-123456'
      )
    ).toBe('$1=[REDACTED] [REDACTED]');
  });

  it('redacts every global case-insensitive match on repeated calls', () => {
    const input =
      'Bearer test-first-token-123456 bearer test-second-token-123456';

    expect(sanitizeGptAccessString(input)).toBe(
      'Bearer [REDACTED] Bearer [REDACTED]'
    );
    expect(sanitizeGptAccessString(input)).toBe(
      'Bearer [REDACTED] Bearer [REDACTED]'
    );
  });

  it('runs shared sensitive-value redaction before GPT Access string shaping', () => {
    expect(
      sanitizeGptAccessPayload('Bearer test-sensitive-token-123456')
    ).toBe('[REDACTED]');
  });

  it('preserves primitives and sanitizes nested arrays without mutating input', () => {
    const input = {
      enabled: true,
      count: 2,
      missing: null,
      values: ['ordinary', { email: 'person@example.com' }],
    };

    expect(sanitizeGptAccessPayload(input)).toEqual({
      enabled: true,
      count: 2,
      missing: null,
      values: ['ordinary', { email: '[REDACTED]' }],
    });
    expect(input.values[1]).toEqual({ email: 'person@example.com' });
  });

  it('preserves email, password, prompt, and diagnostic key precedence', () => {
    expect(
      sanitizeGptAccessPayload({
        Email: 'person@example.com',
        resetPasswordPrompt: 'private password prompt',
        Prompt: 'Bearer test-sensitive-token-123456',
        ProviderPayload: {
          password: 'test-provider-password',
        },
      })
    ).toEqual({
      Email: '[REDACTED]',
      resetPasswordPrompt: '[REDACTED]',
      Prompt: '[REDACTED_PROMPT]',
      ProviderPayload: '[REDACTED_DIAGNOSTIC_PAYLOAD]',
    });
  });

  it.each(PROMPT_FIELD_KEYS)(
    'replaces the complete %s prompt field',
    (key) => {
      expect(
        sanitizeGptAccessPayload({
          [key]: {
            nested: 'private prompt payload',
          },
        })
      ).toEqual({
        [key]: '[REDACTED_PROMPT]',
      });
    }
  );

  it.each(DIAGNOSTIC_FIELD_KEYS)(
    'replaces the complete %s diagnostic field',
    (key) => {
      expect(
        sanitizeGptAccessPayload({
          [key]: {
            nested: 'private diagnostic payload',
          },
        })
      ).toEqual({
        [key]: '[REDACTED_DIAGNOSTIC_PAYLOAD]',
      });
    }
  );

  it('lowercases keys without punctuation normalization', () => {
    expect(
      sanitizeGptAccessPayload({
        Prompt_Preview: 'private underscore prompt',
        'prompt-preview': 'ordinary hyphenated value',
        emailAddress: 'person@example.com',
        myPasswordField: 'test-password-value',
        provider_response: 'private provider response',
      })
    ).toEqual({
      Prompt_Preview: '[REDACTED_PROMPT]',
      'prompt-preview': 'ordinary hyphenated value',
      emailAddress: 'person@example.com',
      myPasswordField: '[REDACTED]',
      provider_response: '[REDACTED_DIAGNOSTIC_PAYLOAD]',
    });
  });

  it('drops inherited properties through the existing own-entry projection', () => {
    const input = Object.assign(
      Object.create({ prompt: 'inherited prompt' }) as Record<string, unknown>,
      { ordinary: 'visible' }
    );

    expect(sanitizeGptAccessPayload(input)).toEqual({
      ordinary: 'visible',
    });
  });

  it('replaces credential-shaped property names with unique reserved markers', () => {
    const firstOpenAiKey = ['sk', 'abcdefghijklmnop12345678'].join('-');
    const secondOpenAiKey = ['sk', 'zyxwvutsrqponmlk87654321'].join('-');
    const bearerKey = ['Bearer', 'abcdefghijklmnop12345678'].join(' ');

    expect(
      sanitizeGptAccessPayload({
        '[REDACTED_KEY_1]': 'reserved marker value',
        [firstOpenAiKey]: 'first secret-key value',
        [secondOpenAiKey]: 'second secret-key value',
        [bearerKey]: 'bearer-key value',
        ordinary: 'visible',
      })
    ).toEqual({
      '[REDACTED_KEY_1]': 'reserved marker value',
      '[REDACTED_KEY_2]': 'first secret-key value',
      '[REDACTED_KEY_3]': 'second secret-key value',
      '[REDACTED_KEY_4]': 'bearer-key value',
      ordinary: 'visible',
    });
  });

  it('preserves the shared twelve-level structural redaction bound', () => {
    let nested: unknown = 'deep value';
    for (let depth = 0; depth < 13; depth += 1) {
      nested = { next: nested };
    }

    const rendered = JSON.stringify(sanitizeGptAccessPayload(nested));

    expect(rendered).toContain('[max depth reached]');
    expect(rendered).not.toContain('deep value');
  });
});
