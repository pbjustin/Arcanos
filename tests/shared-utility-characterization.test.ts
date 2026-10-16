import { describe, expect, it } from '@jest/globals';

import { isRecord } from '../src/shared/typeGuards.js';
import { resolveErrorMessage, stringifyError } from '../src/shared/errorUtils.js';
import {
  mapErrorToFriendlyMessage,
  resolveErrorMessage as resolveLegacyErrorMessage
} from '../src/lib/errors/messages.js';
import { ARCANOS_ERROR_MESSAGES } from '../src/platform/runtime/errorMessages.js';

class CustomError extends Error {
  override toString(): string {
    return 'custom error representation';
  }
}

const inheritedMessage: unknown = Object.create({ message: 'inherited message' });
const nullPrototypeRecord: unknown = Object.create(null);

describe('shared record guard characterization', () => {
  it.each([
    ['null', null, false],
    ['undefined', undefined, false],
    ['empty array', [], false],
    ['array with a message', Object.assign([], { message: 'array message' }), false],
    ['string', 'message', false],
    ['empty string', '', false],
    ['number', 42, false],
    ['zero', 0, false],
    ['NaN', Number.NaN, false],
    ['boolean', false, false],
    ['bigint', 1n, false],
    ['symbol', Symbol('failure'), false],
    ['function', () => undefined, false],
    ['plain object', {}, true],
    ['null-prototype object', nullPrototypeRecord, true],
    ['inherited object', inheritedMessage, true],
    ['Error instance', new CustomError('custom message'), true],
    ['Date instance', new Date('2026-07-16T00:00:00.000Z'), true],
    ['boxed primitive', Object('boxed'), true]
  ])('retains the non-null, non-array object contract for %s', (_label, value, expected) => {
    expect(isRecord(value)).toBe(expected);
  });
});

describe('controlled error-message extraction characterization', () => {
  it.each([
    ['null', null, 'controlled fallback'],
    ['undefined', undefined, 'controlled fallback'],
    ['array', [], 'controlled fallback'],
    ['array with a message', Object.assign([], { message: 'array message' }), 'array message'],
    ['number', 42, 'controlled fallback'],
    ['boolean', false, 'controlled fallback'],
    ['bigint', 1n, 'controlled fallback'],
    ['symbol', Symbol('failure'), 'controlled fallback'],
    ['function with a message', Object.assign(() => undefined, { message: 'function message' }), 'controlled fallback'],
    ['plain object', {}, 'controlled fallback'],
    ['null-prototype object', nullPrototypeRecord, 'controlled fallback'],
    ['message object', { message: 'object message' }, 'object message'],
    ['inherited message', inheritedMessage, 'inherited message'],
    ['non-string message', { message: 42 }, 'controlled fallback'],
    ['empty object message', { message: '' }, ''],
    ['Error', new Error('error message'), 'error message'],
    ['custom Error', new CustomError('custom message'), 'custom message'],
    ['empty Error message', new Error(''), ''],
    ['string', 'string message', 'string message'],
    ['empty string', '', ''],
    ['whitespace string', '  ', '  '],
    ['custom diagnostic stringification', { toString: () => 'raw diagnostic' }, 'controlled fallback']
  ])('preserves the controlled fallback contract for %s', (_label, value, expected) => {
    expect(resolveErrorMessage(value, 'controlled fallback')).toBe(expected);
    expect(resolveLegacyErrorMessage(value, 'controlled fallback')).toBe(expected);
  });

  it('retains the existing default fallback and legacy export', () => {
    expect(resolveErrorMessage(undefined)).toBe('Unknown error');
    expect(resolveLegacyErrorMessage).toBe(resolveErrorMessage);
  });

  it('does not swallow a throwing message getter', () => {
    const failure = new Error('message access failed');
    const value = { get message() { throw failure; } };
    expect(() => resolveErrorMessage(value)).toThrow(failure);
  });
});

describe('raw diagnostic stringification characterization', () => {
  it.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['empty array', [], ''],
    ['array', [1, 'two'], '1,two'],
    ['number', 42, '42'],
    ['boolean', false, 'false'],
    ['bigint', 1n, '1'],
    ['symbol', Symbol('failure'), 'Symbol(failure)'],
    ['plain object', {}, '[object Object]'],
    ['message object', { message: 'object message' }, '[object Object]'],
    ['Error', new Error('error message'), 'error message'],
    ['custom Error', new CustomError('custom message'), 'custom message'],
    ['empty Error message', new Error(''), ''],
    ['string', 'string message', 'string message'],
    ['empty string', '', ''],
    ['whitespace string', '  ', '  '],
    ['custom toString', { toString: () => 'raw diagnostic' }, 'raw diagnostic'],
    ['custom primitive coercion', { [Symbol.toPrimitive]: () => 'primitive diagnostic' }, 'primitive diagnostic']
  ])('preserves the raw diagnostic contract for %s', (_label, value, expected) => {
    expect(stringifyError(value)).toBe(expected);
  });

  it('does not read an ordinary object message field', () => {
    const value = { get message() { throw new Error('must not read message'); } };
    expect(stringifyError(value)).toBe('[object Object]');
  });

  it('preserves failures from values that cannot be stringified', () => {
    const failure = new Error('string conversion failed');
    expect(() => stringifyError(nullPrototypeRecord)).toThrow(TypeError);
    expect(() => stringifyError({ toString() { throw failure; } })).toThrow(failure);
  });

  it('keeps friendly mapping based on raw diagnostics rather than message extraction', () => {
    expect(mapErrorToFriendlyMessage(new CustomError('timeout'))).toBe(ARCANOS_ERROR_MESSAGES.timeout);
    expect(mapErrorToFriendlyMessage({ message: 'timeout' })).toBeNull();
    expect(mapErrorToFriendlyMessage({ toString: () => 'timeout' })).toBe(ARCANOS_ERROR_MESSAGES.timeout);
    expect(mapErrorToFriendlyMessage(null)).toBeNull();
  });
});
