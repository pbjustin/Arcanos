/**
 * JSON Helper Utilities
 * Centralized JSON parsing, validation, and schema utilities
 */

import { logger } from './structuredLogging.js';

export interface JSONParseResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SchemaValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Safe JSON parsing with detailed error handling
 * @param input - String to parse as JSON
 * @param context - Optional context for logging
 * @returns Parse result with success flag and data or error
 */
export function safeJSONParse<T = any>(input: string, context?: string): JSONParseResult<T> {
  try {
    const data = JSON.parse(input);
    return { success: true, data };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown parsing error';
    
    logger.warn('JSON parsing failed', {
      module: 'jsonHelpers',
      operation: 'safeJSONParse',
      context: context || 'unknown',
      error: errorMsg,
      inputLength: input?.length || 0
    });

    return { 
      success: false, 
      error: errorMsg 
    };
  }
}

/**
 * Safe JSON stringify with error handling
 * @param data - Data to stringify
 * @param context - Optional context for logging
 * @returns Stringified JSON or null on error
 */
export function safeJSONStringify(data: any, context?: string): string | null {
  try {
    return JSON.stringify(data);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown stringify error';
    
    logger.warn('JSON stringification failed', {
      module: 'jsonHelpers',
      operation: 'safeJSONStringify',
      context: context || 'unknown',
      error: errorMsg,
      dataType: typeof data
    });

    return null;
  }
}

/**
 * Basic schema validation for common patterns
 * @param data - Data to validate
 * @param schema - Simple schema definition
 * @returns Validation result
 */
export function validateSchema(data: any, schema: {
  required?: string[];
  types?: Record<string, string>;
  minLength?: Record<string, number>;
  maxLength?: Record<string, number>;
}): SchemaValidationResult {
  const errors: string[] = [];

  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['Data must be an object'] };
  }

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in data) || data[field] === null || data[field] === undefined) {
        errors.push(`Required field missing: ${field}`);
      }
    }
  }

  // Check field types
  if (schema.types) {
    for (const [field, expectedType] of Object.entries(schema.types)) {
      if (field in data && typeof data[field] !== expectedType) {
        errors.push(`Field ${field} must be of type ${expectedType}, got ${typeof data[field]}`);
      }
    }
  }

  // Check minimum lengths
  if (schema.minLength) {
    for (const [field, minLen] of Object.entries(schema.minLength)) {
      if (field in data && typeof data[field] === 'string' && data[field].length < minLen) {
        errors.push(`Field ${field} must be at least ${minLen} characters long`);
      }
    }
  }

  // Check maximum lengths
  if (schema.maxLength) {
    for (const [field, maxLen] of Object.entries(schema.maxLength)) {
      if (field in data && typeof data[field] === 'string' && data[field].length > maxLen) {
        errors.push(`Field ${field} must be no more than ${maxLen} characters long`);
      }
    }
  }

  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Common request validation schemas
 */
export const REQUEST_SCHEMAS = {
  AI_REQUEST: {
    required: ['prompt'],
    types: { prompt: 'string' },
    minLength: { prompt: 1 },
    maxLength: { prompt: 10000 }
  },
  
  MEMORY_SAVE: {
    required: ['key', 'value'],
    types: { key: 'string', value: 'string' },
    minLength: { key: 1, value: 1 }
  },
  
  USER_REQUEST: {
    types: { sessionId: 'string', userId: 'string' }
  }
} as const;

export default {
  safeJSONParse,
  safeJSONStringify,
  validateSchema,
  REQUEST_SCHEMAS
};