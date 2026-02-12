/**
 * JSON Helper Utilities
 * Centralized JSON parsing, validation, and schema utilities
 */

import { resolveErrorMessage } from "@shared/errorUtils.js";

export interface JSONParseResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface SchemaValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface JsonHelpersLogger {
  warn: (message: string, metadata: Record<string, unknown>) => void;
}

export interface JsonHelpersDependencies {
  logger?: JsonHelpersLogger;
}

const defaultJsonHelpersLogger: JsonHelpersLogger = {
  warn: (message: string, metadata: Record<string, unknown>): void => {
    console.warn(message, metadata);
  }
};

function resolveJsonHelpersLogger(dependencies: JsonHelpersDependencies): JsonHelpersLogger {
  return dependencies.logger ?? defaultJsonHelpersLogger;
}

/**
 * Safe JSON parsing with detailed error handling
 * @param input - String to parse as JSON
 * @param context - Optional context for logging
 * @returns Parse result with success flag and data or error
 */
export function safeJSONParse<T = unknown>(
  input: string,
  context?: string,
  dependencies: JsonHelpersDependencies = {}
): JSONParseResult<T> {
  const activeLogger = resolveJsonHelpersLogger(dependencies);

  try {
    const data = JSON.parse(input);
    return { success: true, data };
  } catch (error: unknown) {
    //audit Assumption: parse errors should not bubble; Handling: log + safe result
    const errorMsg = resolveErrorMessage(error, 'Unknown parsing error');
    
    activeLogger.warn('JSON parsing failed', {
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
export function safeJSONStringify(
  data: unknown,
  context?: string,
  dependencies: JsonHelpersDependencies = {}
): string | null {
  const activeLogger = resolveJsonHelpersLogger(dependencies);

  try {
    return JSON.stringify(data);
  } catch (error: unknown) {
    //audit Assumption: stringify errors should not crash; Handling: log + null
    const errorMsg = resolveErrorMessage(error, 'Unknown stringify error');
    
    activeLogger.warn('JSON stringification failed', {
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
export function validateSchema(data: unknown, schema: {
  required?: string[];
  types?: Record<string, string>;
  minLength?: Record<string, number>;
  maxLength?: Record<string, number>;
}): SchemaValidationResult {
  const errors: string[] = [];

  //audit Assumption: schema validation expects object inputs; Handling: reject others
  if (!data || typeof data !== 'object') {
    return { isValid: false, errors: ['Data must be an object'] };
  }
  const record = data as Record<string, unknown>;

  // Check required fields
  //audit Assumption: missing required fields invalidate payload; Handling: add errors
  if (schema.required) {
    for (const field of schema.required) {
      if (!(field in record) || record[field] === null || record[field] === undefined) {
        errors.push(`Required field missing: ${field}`);
      }
    }
  }

  // Check field types
  //audit Assumption: typeof checks are sufficient for schema types
  if (schema.types) {
    for (const [field, expectedType] of Object.entries(schema.types)) {
      if (field in record && typeof record[field] !== expectedType) {
        errors.push(`Field ${field} must be of type ${expectedType}, got ${typeof record[field]}`);
      }
    }
  }

  // Check minimum lengths
  //audit Assumption: string length validation applies only to strings
  if (schema.minLength) {
    for (const [field, minLen] of Object.entries(schema.minLength)) {
      if (field in record && typeof record[field] === 'string' && record[field].length < minLen) {
        errors.push(`Field ${field} must be at least ${minLen} characters long`);
      }
    }
  }

  // Check maximum lengths
  //audit Assumption: string length validation applies only to strings
  if (schema.maxLength) {
    for (const [field, maxLen] of Object.entries(schema.maxLength)) {
      if (field in record && typeof record[field] === 'string' && record[field].length > maxLen) {
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
