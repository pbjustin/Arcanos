import { z } from 'zod';

/** Replace native .min() only where a non-ASCII minimum above one was supported. */
export function utf16MinLength(minimum: number, message?: string) {
  return [z.check<string>(context => {
    if (context.value.length >= minimum) return;
    context.issues.push({
      code: 'too_small', origin: 'string', minimum, inclusive: true,
      input: context.value, continue: true,
      message: message ?? `String must contain at least ${minimum} character(s)`
    });
  }), z.meta({ minLength: minimum })] as const;
}

/** Pair with native .max() to retain both its JSON Schema cap and UTF-16 admission. */
export function utf16MaxLength(maximum: number, message?: string) {
  return z.check<string>(context => {
    if (context.value.length <= maximum) return;
    // Native Zod 4 already reports code-point overflow. Only add the legacy
    // error for strings it admits, avoiding duplicate issues for ordinary text.
    let codePoints = 0;
    for (const _character of context.value) {
      codePoints += 1;
      if (codePoints > maximum) return;
    }
    context.issues.push({
      code: 'too_big', origin: 'string', maximum, inclusive: true,
      input: context.value, continue: true,
      message: message ?? `String must contain at most ${maximum} character(s)`
    });
  });
}

/** Zod 3 accepted the UUID shape without enforcing version/variant bits. */
export function legacyUuid() {
  return z.guid({ error: 'Invalid uuid' });
}

/** Retain existing timestamp inputs, including minute precision and compact offsets. */
export function legacyDatetime(options: { offset?: boolean } = {}) {
  const date = z.regexes.date.source.slice(1, -1);
  const time = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?';
  const zone = options.offset ? '(?:Z|[+-]\\d{2}:?\\d{2})' : 'Z';
  return z.stringFormat('datetime', new RegExp(`^${date}T${time}${zone}$`), { error: 'Invalid datetime' });
}
