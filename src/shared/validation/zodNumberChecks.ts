import { z } from 'zod';

/** Preserve finite integer admission and continuing float errors without adding safe-integer bounds. */
export function legacyInteger() {
  return [z.check<number>(context => {
    if (Number.isInteger(context.value)) return;
    context.issues.push({
      code: 'invalid_type', expected: 'int', input: context.value,
      message: 'Expected integer, received float', continue: true
    });
  }), z.meta({ type: 'integer' })] as const;
}
