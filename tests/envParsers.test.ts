import { parseEnvBoolean, parseEnvFloat, parseEnvInt, parseEnvInteger } from '@platform/runtime/envParsers.js';

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

  describe('existing parsers remain stable', () => {
    it('parseEnvInt handles integer conversion with fallback', () => {
      expect(parseEnvInt('12', 1)).toBe(12);
      expect(parseEnvInt('abc', 1)).toBe(1);
    });

    it('parseEnvFloat handles float conversion with fallback', () => {
      expect(parseEnvFloat('12.34', 1)).toBe(12.34);
      expect(parseEnvFloat('abc', 1)).toBe(1);
    });

    it('parseEnvBoolean handles explicit true/false mappings and fallback', () => {
      expect(parseEnvBoolean('yes', false)).toBe(true);
      expect(parseEnvBoolean('off', true)).toBe(false);
      expect(parseEnvBoolean('unknown', true)).toBe(true);
    });
  });
});
