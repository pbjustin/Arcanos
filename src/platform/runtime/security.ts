/**
 * Enhanced Input Validation and Sanitization
 * Provides comprehensive input validation and security measures
 */

import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

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

interface ValidationErrorPayload {
  error: string;
  details: string[];
  timestamp: string;
}

/**
 * Build a validation error payload without cross-layer dependencies.
 * Purpose: Keep platform validation responses deterministic and serializable.
 * Inputs/Outputs: Accepts validation messages, returns standardized payload object.
 * Edge cases: Empty arrays still produce a valid payload shape.
 */
function buildValidationErrorPayload(errors: string[]): ValidationErrorPayload {
  return {
    error: 'Validation failed',
    details: errors,
    timestamp: new Date().toISOString()
  };
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

export function createValidationMiddleware(schema: ValidationSchema) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const validation = validateInput(req.body, schema);
    
    if (!validation.isValid) {
      //audit Assumption: validation errors map directly to client payload; risk: leaking schema details; invariant: only include validation errors; handling: standardized payload.
      res.status(400).json(buildValidationErrorPayload(validation.errors));
      return;
    }
    
    // Replace request body with sanitized version
    req.body = validation.sanitized;
    next();
  };
}

/**
 * Rate-limit policy resolved for one request.
 * Purpose: carry the selected bucket settings into the middleware execution path.
 * Inputs/outputs: defines the bucket name, request ceiling, and reset window in milliseconds.
 * Edge cases: bucket names must be stable because they are used in the in-memory key space.
 */
export interface RateLimitPolicy {
  bucketName: string;
  maxRequests: number;
  windowMs: number;
}

/**
 * Configures actor-aware rate limiting with optional per-request policy selection.
 * Purpose: let routes isolate high-frequency status reads from heavier mutation or AI calls.
 * Inputs/outputs: accepts static limits or an options object with policy/key resolvers; returns Express middleware.
 * Edge cases: falls back to IP-based buckets when no richer actor identity is available.
 */
export interface RateLimitMiddlewareOptions {
  bucketName?: string;
  maxRequests?: number;
  windowMs?: number;
  keyGenerator?: (req: Request) => string;
  policyResolver?: (req: Request, defaultPolicy: RateLimitPolicy) => RateLimitPolicy;
  skip?: (req: Request) => boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function getNormalizedHeader(req: Request, headerName: string): string | undefined {
  const value = req.header(headerName);
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function getFirstForwardedAddress(req: Request): string | undefined {
  const forwardedFor = getNormalizedHeader(req, 'x-forwarded-for');
  if (!forwardedFor) {
    return undefined;
  }

  const [firstAddress] = forwardedFor.split(',');
  return isNonEmptyString(firstAddress) ? firstAddress.trim() : undefined;
}

function getBodyOrQueryField(
  source: unknown,
  fieldName: string
): string | undefined {
  if (!source || typeof source !== 'object') {
    return undefined;
  }

  const rawValue = (source as Record<string, unknown>)[fieldName];
  const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
  return isNonEmptyString(value) ? value.trim() : undefined;
}

function fingerprintSecretValue(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * Resolve the best-effort session id carried by the current request.
 * Purpose: allow chat, DAG, and MCP traffic to rate-limit per active session instead of per shared IP.
 * Inputs/outputs: inspects headers, body, and query string for a session identifier and returns it when present.
 * Edge cases: returns `undefined` when the caller did not provide a stable session id.
 */
export function getRequestSessionId(req: Request): string | undefined {
  const headerSessionId =
    getNormalizedHeader(req, 'x-session-id') ??
    getNormalizedHeader(req, 'mcp-session-id');
  if (headerSessionId) {
    return headerSessionId;
  }

  const bodySessionId = getBodyOrQueryField(req.body, 'sessionId');
  if (bodySessionId) {
    return bodySessionId;
  }

  return getBodyOrQueryField(req.query, 'sessionId');
}

/**
 * Resolve the client address used as the final fallback rate-limit identity.
 * Purpose: preserve the previous IP-based behavior when no user or session information exists.
 * Inputs/outputs: reads proxy headers and Express connection metadata and returns one normalized address string.
 * Edge cases: returns `unknown` when the runtime cannot determine a client address.
 */
export function getRequestClientAddress(req: Request): string {
  const forwardedAddress = getFirstForwardedAddress(req);
  if (forwardedAddress) {
    return forwardedAddress;
  }

  const expressAddress = isNonEmptyString(req.ip) ? req.ip.trim() : undefined;
  if (expressAddress) {
    return expressAddress;
  }

  const socketAddress = isNonEmptyString(req.connection?.remoteAddress)
    ? req.connection.remoteAddress.trim()
    : undefined;
  if (socketAddress) {
    return socketAddress;
  }

  return 'unknown';
}

/**
 * Resolve the most specific actor identity available for rate limiting.
 * Purpose: prevent one shared IP from throttling multiple AI sessions or DAG runs behind the same proxy.
 * Inputs/outputs: inspects session id, authenticated user, bearer token, and IP metadata to build a stable actor key.
 * Edge cases: hashes bearer credentials before use and falls back to IP when no richer identity is available.
 */
export function getRequestActorKey(req: Request): string {
  const sessionId = getRequestSessionId(req);
  if (sessionId) {
    return `session:${sessionId}`;
  }

  if (req.authUser?.id !== undefined) {
    return `user:${req.authUser.id}`;
  }

  const operatorActor = isNonEmptyString(req.operatorActor) ? req.operatorActor.trim() : undefined;
  if (operatorActor) {
    return `operator:${operatorActor}`;
  }

  const daemonToken = isNonEmptyString(req.daemonToken) ? req.daemonToken.trim() : undefined;
  if (daemonToken) {
    return `daemon:${fingerprintSecretValue(daemonToken)}`;
  }

  const authorizationHeader = getNormalizedHeader(req, 'authorization');
  if (authorizationHeader) {
    return `auth:${fingerprintSecretValue(authorizationHeader)}`;
  }

  return `ip:${getRequestClientAddress(req)}`;
}

function resolveRateLimitOptions(
  maxRequestsOrOptions: number | RateLimitMiddlewareOptions,
  windowMs: number
): RateLimitMiddlewareOptions {
  if (typeof maxRequestsOrOptions === 'number') {
    return {
      maxRequests: maxRequestsOrOptions,
      windowMs
    };
  }

  return maxRequestsOrOptions;
}

function resolveRateLimitPolicy(
  req: Request,
  options: RateLimitMiddlewareOptions
): RateLimitPolicy {
  const defaultPolicy: RateLimitPolicy = {
    bucketName: options.bucketName ?? 'default',
    maxRequests: options.maxRequests ?? 100,
    windowMs: options.windowMs ?? 15 * 60 * 1000
  };

  //audit Assumption: routes may need per-request policies for read-heavy monitoring traffic; failure risk: all traffic shares one bucket and long-running workflows self-throttle; expected invariant: a valid policy is always returned; handling strategy: fall back to the default policy when no resolver is supplied.
  if (!options.policyResolver) {
    return defaultPolicy;
  }

  return options.policyResolver(req, defaultPolicy);
}

/**
 * Build a reusable rate-limit middleware.
 * Purpose: enforce request ceilings with actor-aware keys and route-selectable policies.
 * Inputs/outputs: accepts legacy numeric arguments or an options object and returns Express middleware.
 * Edge cases: skipped requests bypass counters, and per-request policies may override the default bucket settings.
 */
export function createRateLimitMiddleware(
  maxRequestsOrOptions: number | RateLimitMiddlewareOptions = 100,
  windowMs: number = 15 * 60 * 1000 // 15 minutes
): (req: Request, res: Response, next: NextFunction) => void {
  const options = resolveRateLimitOptions(maxRequestsOrOptions, windowMs);
  const requestCounts = new Map<string, RateLimitEntry>();
  const cleanupIntervalMs = Math.max(1000, Math.min(options.windowMs ?? windowMs, 60 * 1000));

  /**
   * Purge expired rate-limit entries outside the request path.
   *
   * Purpose: keep request handling O(1) while bounding map growth.
   * Inputs/outputs: inspects requestCounts and deletes expired records.
   * Edge cases: no-op when cache is empty.
   */
  function purgeExpiredEntries(): void {
    const now = Date.now();
    for (const [key, value] of requestCounts.entries()) {
      //audit Assumption: entry is stale once reset window has elapsed; risk: stale map growth; invariant: only expired entries are deleted; handling: periodic purge.
      if (now > value.resetTime) {
        requestCounts.delete(key);
      }
    }
  }

  const cleanupTimer = setInterval(() => {
    //audit Assumption: periodic cleanup reduces request-path CPU spikes; risk: short-lived stale entries; invariant: eventual cleanup under continuous uptime; handling: bounded interval purge.
    purgeExpiredEntries();
  }, cleanupIntervalMs);
  cleanupTimer.unref?.();

  return (req: Request, res: Response, next: NextFunction): void => {
    //audit Assumption: some health or internal routes may intentionally bypass rate limiting; failure risk: internal control loops are throttled unnecessarily; expected invariant: only explicitly skipped requests bypass accounting; handling strategy: short-circuit before any counter mutation.
    if (options.skip?.(req)) {
      next();
      return;
    }

    const now = Date.now();
    const policy = resolveRateLimitPolicy(req, options);
    const actorKey = options.keyGenerator ? options.keyGenerator(req) : getRequestActorKey(req);
    const storageKey = `${policy.bucketName}:${actorKey}`;
    const current = requestCounts.get(storageKey) || { count: 0, resetTime: now + policy.windowMs };
    
    //audit Assumption: reset window when elapsed; Handling: reset counters
    if (now > current.resetTime) {
      current.count = 1;
      current.resetTime = now + policy.windowMs;
    } else {
      current.count++;
    }
    
    requestCounts.set(storageKey, current);
    
    //audit Assumption: enforce rate limit threshold; Handling: 429 response
    if (current.count > policy.maxRequests) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.resetTime - now) / 1000));
      res.set({
        'Retry-After': retryAfterSeconds.toString(),
        'X-RateLimit-Limit': policy.maxRequests.toString(),
        'X-RateLimit-Remaining': '0',
        'X-RateLimit-Reset': new Date(current.resetTime).toISOString(),
        'X-RateLimit-Bucket': policy.bucketName
      });
      void res.status(429).json({
        error: 'Rate limit exceeded',
        message: `Too many requests for ${policy.bucketName}. Try again later.`,
        retryAfter: retryAfterSeconds
      });
      return;
    }
    
    // Add rate limit headers
    //audit Assumption: headers help clients back off; Handling: include limits
    res.set({
      'X-RateLimit-Limit': policy.maxRequests.toString(),
      'X-RateLimit-Remaining': Math.max(0, policy.maxRequests - current.count).toString(),
      'X-RateLimit-Reset': new Date(current.resetTime).toISOString(),
      'X-RateLimit-Bucket': policy.bucketName
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
