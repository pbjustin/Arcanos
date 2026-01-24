/**
 * Enhanced Input Validation and Sanitization
 * Provides comprehensive input validation and security measures
 */

import { Response } from 'express';
import { buildValidationErrorResponse } from './errorResponse.js';

// Input validation schemas
export interface ValidationRule {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  sanitize?: boolean;
  allowedValues?: Array<string | number | boolean>;
}

export interface ValidationSchema {
  [key: string]: ValidationRule;
}

/**
 * Sanitizes potentially dangerous input content
 */
export function sanitizeInput(input: string): string {
  //audit Assumption: non-string inputs are unsafe; Handling: return empty string
  if (typeof input !== 'string') return '';
  
  //audit Assumption: sanitization removes dangerous patterns; Risk: over-sanitization
  return input
    // Remove potential script injections
    .replace(/<script[^>]*>.*?<\/script>/gi, '')
    // Remove SQL injection patterns
    .replace(/('|(\\|%27|%22|%5c|%2f))/gi, '')
    // Remove path traversal attempts  
    .replace(/\.\.\//g, '')
    // Remove null bytes
    .replace(/\0/g, '')
    // Limit special characters but preserve basic punctuation
    .replace(/[^\w\s\-_.,!?@#$%^&*()+={}[\]:";'<>|`~\/\\]/g, '')
    .trim();
}

/**
 * Validated and sanitized input result
 * @confidence 1.0 - Type-safe validation result
 */
export interface ValidationResult<T = Record<string, unknown>> {
  isValid: boolean;
  errors: string[];
  sanitized: T;
}

/**
 * Validates and sanitizes input according to schema
 * @confidence 0.9 - Dynamic validation requires runtime type checking
 */
export function validateInput<T extends Record<string, unknown> | unknown[]>(
  data: T, 
  schema: ValidationSchema
): ValidationResult<T> {
  const errors: string[] = [];
  const sanitized = (Array.isArray(data) ? [] : {}) as T;

  for (const [field, rule] of Object.entries(schema)) {
    const value = (data as Record<string, unknown>)[field];
    
    // Check required fields
    //audit Assumption: missing required values invalidate payload; Handling: error
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`Field '${field}' is required`);
      continue;
    }
    
    // Skip validation for optional missing fields
    //audit Assumption: optional missing fields can be ignored; Handling: continue
    if (!rule.required && (value === undefined || value === null)) {
      continue;
    }
    
    // Type validation
    //audit Assumption: runtime type checks match schema intent; Handling: error
    if (rule.type) {
      if (rule.type === 'array' && !Array.isArray(value)) {
        errors.push(`Field '${field}' must be an array`);
        continue;
      } else if (rule.type !== 'array' && typeof value !== rule.type) {
        errors.push(`Field '${field}' must be of type ${rule.type}`);
        continue;
      }
    }
    
    // String-specific validations
    if (rule.type === 'string' && typeof value === 'string') {
      //audit Assumption: length/pattern checks protect input constraints
      if (rule.minLength && value.length < rule.minLength) {
        errors.push(`Field '${field}' must be at least ${rule.minLength} characters`);
      }
      
      if (rule.maxLength && value.length > rule.maxLength) {
        errors.push(`Field '${field}' must be no more than ${rule.maxLength} characters`);
      }
      
      if (rule.pattern && !rule.pattern.test(value)) {
        errors.push(`Field '${field}' does not match required pattern`);
      }
      
      // Apply sanitization
      //audit Assumption: sanitization is safe; Handling: sanitize if enabled
      (sanitized as Record<string, unknown>)[field] = rule.sanitize ? sanitizeInput(value) : value;
    } else if (rule.type === 'array' && Array.isArray(value)) {
      // Array validation
      //audit Assumption: arrays pass through unchanged; Handling: assign
      (sanitized as Record<string, unknown>)[field] = value;
    } else if (rule.type === 'object' && typeof value === 'object' && value !== null) {
      // Object validation
      //audit Assumption: object shape validated elsewhere; Handling: assign
      (sanitized as Record<string, unknown>)[field] = value;
    } else {
      // Other types (number, boolean)
      //audit Assumption: scalar values are safe to store; Handling: assign
      (sanitized as Record<string, unknown>)[field] = value;
    }
    
    // Allowed values validation
    //audit Assumption: allowedValues list is authoritative; Handling: error
    if (
      rule.allowedValues &&
      (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') &&
      !rule.allowedValues.includes(value)
    ) {
      errors.push(`Field '${field}' must be one of: ${rule.allowedValues.join(', ')}`);
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors,
    sanitized
  };
}

/**
 * Express middleware for input validation
 */
/**
 * Express middleware type for validation
 * @confidence 1.0 - Standard Express middleware signature
 */
import type { Request, NextFunction } from 'express';

export function createValidationMiddleware(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const validation = validateInput(req.body, schema);
    
    if (!validation.isValid) {
      //audit Assumption: validation errors map directly to client payload; risk: leaking schema details; invariant: only include validation errors; handling: standardized payload.
      res.status(400).json(buildValidationErrorResponse(validation.errors));
      return;
    }
    
    // Replace request body with sanitized version
    req.body = validation.sanitized;
    next();
  };
}

/**
 * Rate limiting by IP for security
 */
const requestCounts = new Map<string, { count: number; resetTime: number }>();

export function createRateLimitMiddleware(
  maxRequests: number = 100,
  windowMs: number = 15 * 60 * 1000 // 15 minutes
): (req: Request, res: Response, next: NextFunction) => void {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    
    // Clean up old entries
    //audit Assumption: stale entries should be cleared to prevent memory bloat
    for (const [key, value] of requestCounts.entries()) {
      if (now > value.resetTime) {
        requestCounts.delete(key);
      }
    }
    
    const current = requestCounts.get(ip) || { count: 0, resetTime: now + windowMs };
    
    //audit Assumption: reset window when elapsed; Handling: reset counters
    if (now > current.resetTime) {
      current.count = 1;
      current.resetTime = now + windowMs;
    } else {
      current.count++;
    }
    
    requestCounts.set(ip, current);
    
    //audit Assumption: enforce rate limit threshold; Handling: 429 response
    if (current.count > maxRequests) {
      void res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests from ${ip}. Try again later.`,
        retryAfter: Math.ceil((current.resetTime - now) / 1000)
      });
      return;
    }
    
    // Add rate limit headers
    //audit Assumption: headers help clients back off; Handling: include limits
    res.set({
      'X-RateLimit-Limit': maxRequests.toString(),
      'X-RateLimit-Remaining': Math.max(0, maxRequests - current.count).toString(),
      'X-RateLimit-Reset': new Date(current.resetTime).toISOString()
    });
    
    next();
  };
}

/**
 * Security headers middleware
 * @confidence 1.0 - Standard Express middleware
 */
export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  //audit Assumption: static security headers mitigate common attacks
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'X-XSS-Protection': '1; mode=block',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'self'",
    'Referrer-Policy': 'strict-origin-when-cross-origin'
  });
  next();
}

// Common validation schemas
export const commonSchemas = {
  aiRequest: {
    prompt: { required: true, type: 'string', minLength: 1, maxLength: 10000, sanitize: true },
    model: { type: 'string', maxLength: 100, sanitize: true },
    temperature: { type: 'number' },
    max_tokens: { type: 'number' }
  } as ValidationSchema,
  
  memoryRequest: {
    key: { required: true, type: 'string', minLength: 1, maxLength: 255, sanitize: true },
    value: { type: 'string', maxLength: 50000, sanitize: true },
    type: { type: 'string', allowedValues: ['memory', 'session', 'cache'] }
  } as ValidationSchema
};
