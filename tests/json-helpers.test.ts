/**
 * Test for JSON helpers utility
 */

import { describe, test, expect } from '@jest/globals';
import { safeJSONParse, safeJSONStringify, validateSchema, REQUEST_SCHEMAS } from '../src/utils/jsonHelpers.js';

describe('JSON Helpers', () => {
  test('should parse valid JSON safely', () => {
    const result = safeJSONParse('{"test": "value"}');
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ test: 'value' });
    expect(result.error).toBeUndefined();
  });

  test('should handle invalid JSON gracefully', () => {
    const result = safeJSONParse('invalid json');
    expect(result.success).toBe(false);
    expect(result.data).toBeUndefined();
    expect(result.error).toBeDefined();
  });

  test('should stringify data safely', () => {
    const result = safeJSONStringify({ test: 'value' });
    expect(result).toBe('{"test":"value"}');
  });

  test('should handle circular references in stringify', () => {
    const circular: any = { test: 'value' };
    circular.self = circular;
    
    const result = safeJSONStringify(circular);
    expect(result).toBeNull();
  });

  test('should validate schema correctly', () => {
    const validData = { prompt: 'test prompt' };
    const result = validateSchema(validData, REQUEST_SCHEMAS.AI_REQUEST);
    
    expect(result.isValid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('should detect missing required fields', () => {
    const invalidData = {};
    const result = validateSchema(invalidData, REQUEST_SCHEMAS.AI_REQUEST);
    
    expect(result.isValid).toBe(false);
    expect(result.errors).toContain('Required field missing: prompt');
  });

  test('should validate field types', () => {
    const invalidData = { prompt: 123 };
    const result = validateSchema(invalidData, REQUEST_SCHEMAS.AI_REQUEST);
    
    expect(result.isValid).toBe(false);
    expect(result.errors.some(err => err.includes('must be of type string'))).toBe(true);
  });

  test('should validate string lengths', () => {
    const invalidData = { prompt: '' };
    const result = validateSchema(invalidData, REQUEST_SCHEMAS.AI_REQUEST);
    
    expect(result.isValid).toBe(false);
    expect(result.errors.some(err => err.includes('at least 1 characters'))).toBe(true);
  });
});