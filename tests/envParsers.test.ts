import {
  parseEnvBoolean,
  parseEnvFloat,
  parseEnvInt,
  parseEnvInteger,
  parsePositiveEnvInteger,
} from '@platform/runtime/envParsers.js';

describe('envParsers', () => {
  describe('parseEnvInteger', () => {
    it('returns fallback when value is undefined', () => {
      expect(parseEnvInteger(undefined, 42)).toBe(42);
    });

    it('returns fallback when value is not finite', () => {
      expect(parseEnvInteger('NaN', 9)).toBe(9);
      expect(parseEnvInteger('Infinity', 9)).toBe(9);
    });

    it('enforces allowZero and minimum bounds', () => {
      expect(parseEnvInteger('0', 7, { allowZero: false })).toBe(7);
      expect(parseEnvInteger('0', 7, { allowZero: true, minimum: 0 })).toBe(0);
      expect(parseEnvInteger('-3', 7, { minimum: 0 })).toBe(7);
    });

    it('enforces maximum bounds', () => {
      expect(parseEnvInteger('101', 50, { maximum: 100 })).toBe(50);
      expect(parseEnvInteger('100', 50, { maximum: 100 })).toBe(100);
    });

    it('supports configurable rounding mode', () => {
      expect(parseEnvInteger('-1.2', 5, { roundingMode: 'trunc' })).toBe(-1);
      expect(parseEnvInteger('-1.2', 5, { roundingMode: 'floor' })).toBe(-2);
    });
  });


  describe('parsePositiveEnvInteger', () => {
    it('returns fallback for undefined, zero, and negative values', () => {
      expect(parsePositiveEnvInteger(undefined, 25)).toBe(25);
      expect(parsePositiveEnvInteger('0', 25)).toBe(25);
      expect(parsePositiveEnvInteger('-2', 25)).toBe(25);
    });

    it('returns parsed positive integer and truncates decimals', () => {
      expect(parsePositiveEnvInteger('42', 10)).toBe(42);
      expect(parsePositiveEnvInteger('9.7', 10)).toBe(9);
    });

    it('enforces optional minimum and maximum bounds', () => {
      expect(parsePositiveEnvInteger('4', 10, { minimum: 5 })).toBe(10);
      expect(parsePositiveEnvInteger('101', 10, { maximum: 100 })).toBe(10);
      expect(parsePositiveEnvInteger('100', 10, { maximum: 100 })).toBe(100);
    });
  });

  describe('existing parsers remain stable', () => {
    it('parseEnvInt handles integer conversion with fallback', () => {
      expect(parseEnvInt(undefined, 1)).toBe(1);
      expect(parseEnvInt('', 1)).toBe(1);
      expect(parseEnvInt('12', 1)).toBe(12);
      expect(parseEnvInt('12.9', 1)).toBe(12);
      expect(parseEnvInt('12px', 1)).toBe(12);
      expect(parseEnvInt('abc', 1)).toBe(1);
    });

    it('parseEnvFloat handles float conversion with fallback', () => {
      expect(parseEnvFloat(undefined, 1)).toBe(1);
      expect(parseEnvFloat('', 1)).toBe(1);
      expect(parseEnvFloat('12.34', 1)).toBe(12.34);
      expect(parseEnvFloat('12.34rem', 1)).toBe(12.34);
      expect(parseEnvFloat(' 8.5 ', 1)).toBe(8.5);
      expect(parseEnvFloat('abc', 1)).toBe(1);
    });

    it('parseEnvBoolean handles explicit true/false mappings and fallback', () => {
      expect(parseEnvBoolean(undefined, true)).toBe(true);
      expect(parseEnvBoolean(undefined, false)).toBe(false);
      expect(parseEnvBoolean('true', false)).toBe(true);
      expect(parseEnvBoolean('false', true)).toBe(false);
      expect(parseEnvBoolean('1', false)).toBe(true);
      expect(parseEnvBoolean('0', true)).toBe(false);
      expect(parseEnvBoolean('on', false)).toBe(true);
      expect(parseEnvBoolean('no', true)).toBe(false);
      expect(parseEnvBoolean(' TRUE ', false)).toBe(true);
      expect(parseEnvBoolean(' OFF ', true)).toBe(false);
      expect(parseEnvBoolean('', true)).toBe(true);
      expect(parseEnvBoolean('yes', false)).toBe(true);
      expect(parseEnvBoolean('off', true)).toBe(false);
      expect(parseEnvBoolean('unknown', true)).toBe(true);
    });
  });
});
