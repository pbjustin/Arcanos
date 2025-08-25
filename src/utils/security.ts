/**
 * Enhanced Input Validation and Sanitization
 * Provides comprehensive input validation and security measures
 */

import { Response } from 'express';

// Input validation schemas
export interface ValidationRule {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  sanitize?: boolean;
  allowedValues?: any[];
}

export interface ValidationSchema {
  [key: string]: ValidationRule;
}

/**
 * Sanitizes potentially dangerous input content
 */
export function sanitizeInput(input: string): string {
  if (typeof input !== 'string') return '';
  
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
 * Validates and sanitizes input according to schema
 */
export function validateInput(data: any, schema: ValidationSchema): { 
  isValid: boolean; 
  errors: string[]; 
  sanitized: any 
} {
  const errors: string[] = [];
  const sanitized: any = Array.isArray(data) ? [] : {};

  for (const [field, rule] of Object.entries(schema)) {
    const value = data[field];
    
    // Check required fields
    if (rule.required && (value === undefined || value === null || value === '')) {
      errors.push(`Field '${field}' is required`);
      continue;
    }
    
    // Skip validation for optional missing fields
    if (!rule.required && (value === undefined || value === null)) {
      continue;
    }
    
    // Type validation
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
      sanitized[field] = rule.sanitize ? sanitizeInput(value) : value;
    } else if (rule.type === 'array' && Array.isArray(value)) {
      // Array validation
      sanitized[field] = value;
    } else if (rule.type === 'object' && typeof value === 'object' && value !== null) {
      // Object validation
      sanitized[field] = value;
    } else {
      // Other types (number, boolean)
      sanitized[field] = value;
    }
    
    // Allowed values validation
    if (rule.allowedValues && !rule.allowedValues.includes(value)) {
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
export function createValidationMiddleware(schema: ValidationSchema) {
  return (req: any, res: Response, next: any) => {
    const validation = validateInput(req.body, schema);
    
    if (!validation.isValid) {
      return res.status(400).json({
        error: 'Validation failed',
        details: validation.errors,
        timestamp: new Date().toISOString()
      });
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
) {
  return (req: any, res: Response, next: any) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    
    // Clean up old entries
    for (const [key, value] of requestCounts.entries()) {
      if (now > value.resetTime) {
        requestCounts.delete(key);
      }
    }
    
    const current = requestCounts.get(ip) || { count: 0, resetTime: now + windowMs };
    
    if (now > current.resetTime) {
      current.count = 1;
      current.resetTime = now + windowMs;
    } else {
      current.count++;
    }
    
    requestCounts.set(ip, current);
    
    if (current.count > maxRequests) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests from ${ip}. Try again later.`,
        retryAfter: Math.ceil((current.resetTime - now) / 1000)
      });
    }
    
    // Add rate limit headers
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
 */
export function securityHeaders(req: any, res: Response, next: any) {
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