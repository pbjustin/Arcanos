/**
 * JSON Schema Validation Layer
 * Provides comprehensive validation for all POST payloads with standardized error responses
 */

import { Request, Response, NextFunction } from 'express';

// JSON Schema definitions for different endpoints
export const schemas = {
  aiRequest: {
    type: 'object',
    properties: {
      prompt: { type: 'string', minLength: 1, maxLength: 10000 },
      userInput: { type: 'string', minLength: 1, maxLength: 10000 },
      content: { type: 'string', minLength: 1, maxLength: 10000 },
      text: { type: 'string', minLength: 1, maxLength: 10000 },
      model: { type: 'string', pattern: '^(gpt-|ft:)' },
      maxTokens: { type: 'number', minimum: 1, maximum: 4096 },
      temperature: { type: 'number', minimum: 0, maximum: 2 }
    },
    anyOf: [
      { required: ['prompt'] },
      { required: ['userInput'] },
      { required: ['content'] },
      { required: ['text'] }
    ],
    additionalProperties: true
  },

  assistantRequest: {
    type: 'object',
    properties: {
      thread_id: { type: 'string' },
      assistant_id: { type: 'string' },
      message: { type: 'string', minLength: 1, maxLength: 32000 },
      instructions: { type: 'string', maxLength: 32000 },
      model: { type: 'string' },
      tools: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['code_interpreter', 'retrieval', 'function'] }
          }
        }
      }
    },
    required: ['message'],
    additionalProperties: false
  },

  fileUpload: {
    type: 'object',
    properties: {
      file: { type: 'string' }, // base64 encoded or file path
      purpose: { type: 'string', enum: ['fine-tune', 'assistants'] },
      filename: { type: 'string', minLength: 1 }
    },
    required: ['file', 'purpose'],
    additionalProperties: false
  },

  memoryRequest: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['save', 'retrieve', 'delete', 'list'] },
      key: { type: 'string', minLength: 1 },
      value: { type: 'object' },
      namespace: { type: 'string' }
    },
    required: ['action'],
    additionalProperties: false
  },

  purificationRequest: {
    type: 'object',
    properties: {
      targetPath: { type: 'string', minLength: 1, maxLength: 500 },
      config: { type: 'object' }
    },
    additionalProperties: false
  },

  purificationApply: {
    type: 'object',
    properties: {
      recommendations: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['remove', 'refactor', 'consolidate'] },
            target: { type: 'string', minLength: 1 },
            reason: { type: 'string', minLength: 1 },
            confidence: { type: 'number', minimum: 0, maximum: 1 }
          },
          required: ['action', 'target', 'reason', 'confidence']
        }
      },
      dryRun: { type: 'boolean' }
    },
    required: ['recommendations'],
    additionalProperties: false
  }
};

/**
 * Standardized error response format
 */
export interface ValidationErrorResponse {
  error: string;
  details: {
    field?: string;
    value?: any;
    expected?: string;
    code: string;
  };
  timestamp: string;
  endpoint: string;
}

/**
 * Simple JSON schema validator (basic implementation)
 */
class JSONSchemaValidator {
  /**
   * Validate an object against a schema
   */
  static validate(data: any, schema: any): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Type validation
    if (schema.type && typeof data !== schema.type) {
      errors.push(`Expected type ${schema.type}, got ${typeof data}`);
      return { valid: false, errors };
    }

    if (schema.type === 'object' && data && typeof data === 'object') {
      // Required properties
      if (schema.required) {
        for (const required of schema.required) {
          if (!(required in data)) {
            errors.push(`Missing required property: ${required}`);
          }
        }
      }

      // anyOf validation
      if (schema.anyOf) {
        const anyOfValid = schema.anyOf.some((subSchema: any) => {
          if (subSchema.required) {
            return subSchema.required.every((prop: string) => prop in data);
          }
          return true;
        });
        
        if (!anyOfValid) {
          errors.push('Must satisfy at least one of the required property groups');
        }
      }

      // Property validation
      if (schema.properties) {
        for (const [key, value] of Object.entries(data)) {
          const propSchema = schema.properties[key];
          if (propSchema) {
            const propValidation = this.validateProperty(value, propSchema, key);
            errors.push(...propValidation.errors);
          } else if (schema.additionalProperties === false) {
            errors.push(`Additional property not allowed: ${key}`);
          }
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate a single property
   */
  private static validateProperty(value: any, schema: any, propertyName: string): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Type check
    if (schema.type && typeof value !== schema.type) {
      errors.push(`Property ${propertyName}: expected ${schema.type}, got ${typeof value}`);
      return { valid: false, errors };
    }

    // String validations
    if (schema.type === 'string' && typeof value === 'string') {
      if (schema.minLength && value.length < schema.minLength) {
        errors.push(`Property ${propertyName}: minimum length is ${schema.minLength}`);
      }
      if (schema.maxLength && value.length > schema.maxLength) {
        errors.push(`Property ${propertyName}: maximum length is ${schema.maxLength}`);
      }
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        errors.push(`Property ${propertyName}: does not match required pattern`);
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`Property ${propertyName}: must be one of ${schema.enum.join(', ')}`);
      }
    }

    // Number validations
    if (schema.type === 'number' && typeof value === 'number') {
      if (schema.minimum && value < schema.minimum) {
        errors.push(`Property ${propertyName}: minimum value is ${schema.minimum}`);
      }
      if (schema.maximum && value > schema.maximum) {
        errors.push(`Property ${propertyName}: maximum value is ${schema.maximum}`);
      }
    }

    // Array validations
    if (schema.type === 'array' && Array.isArray(value)) {
      if (schema.items) {
        value.forEach((item, index) => {
          const itemValidation = JSONSchemaValidator.validate(item, schema.items);
          errors.push(...itemValidation.errors.map(err => `Property ${propertyName}[${index}]: ${err}`));
        });
      }
    }

    return { valid: errors.length === 0, errors };
  }
}

/**
 * Middleware factory for JSON schema validation
 */
export function validateSchema(schemaName: keyof typeof schemas) {
  return (req: Request, res: Response, next: NextFunction) => {
    const schema = schemas[schemaName];
    if (!schema) {
      return res.status(500).json({
        error: 'Internal validation error',
        details: {
          code: 'SCHEMA_NOT_FOUND',
          expected: `Valid schema name (${Object.keys(schemas).join(', ')})`
        },
        timestamp: new Date().toISOString(),
        endpoint: req.path
      });
    }

    const validation = JSONSchemaValidator.validate(req.body, schema);
    
    if (!validation.valid) {
      const errorResponse: ValidationErrorResponse = {
        error: 'Validation failed',
        details: {
          code: 'VALIDATION_ERROR',
          expected: validation.errors.join('; ')
        },
        timestamp: new Date().toISOString(),
        endpoint: req.path
      };

      return res.status(400).json(errorResponse);
    }

    next();
  };
}

/**
 * Generic validation middleware for custom validation functions
 */
export function validateCustom(validator: (data: any) => { valid: boolean; errors: string[] }) {
  return (req: Request, res: Response, next: NextFunction) => {
    const validation = validator(req.body);
    
    if (!validation.valid) {
      const errorResponse: ValidationErrorResponse = {
        error: 'Validation failed',
        details: {
          code: 'VALIDATION_ERROR',
          expected: validation.errors.join('; ')
        },
        timestamp: new Date().toISOString(),
        endpoint: req.path
      };

      return res.status(400).json(errorResponse);
    }

    next();
  };
}

export default { validateSchema, validateCustom, schemas };