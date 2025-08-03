import { Request, Response, NextFunction } from 'express';
import { chatGPTUserWhitelist } from '../services/chatgpt-user-whitelist.js';

// Define the exact ChatGPT-User agent string
const CHATGPT_USER_AGENT = 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot';

// Rate limiting storage (simple in-memory)
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 10; // Max requests per window

interface ChatGPTUserOptions {
  allowPostMethods?: boolean;
  rateLimit?: boolean;
  logToFile?: boolean;
  diagnosticsQueue?: any; // Could be enhanced with proper queue interface
}

/**
 * Middleware to handle ChatGPT-User agent requests
 * Detects the specific user agent, validates IP against whitelist, and applies policies
 */
export function chatGPTUserMiddleware(options: ChatGPTUserOptions = {}) {
  const { 
    allowPostMethods = false, 
    rateLimit = true,
    diagnosticsQueue
  } = options;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Check if handler is enabled
    if (!isEnabled()) {
      return next();
    }

    const userAgent = req.get('User-Agent') || '';
    const clientIp = getClientIP(req);
    const method = req.method;
    const url = req.url;
    const timestamp = new Date().toISOString();

    // Check if this is a ChatGPT-User request
    if (userAgent === CHATGPT_USER_AGENT) {
      // Verify IP is whitelisted
      const isWhitelisted = await chatGPTUserWhitelist.isIpWhitelisted(clientIp);
      const verificationFlag = isWhitelisted ? '[CHATGPT-USER ACCESS]' : '[UNVERIFIED GPT REQUEST]';
      
      // Create log entry
      const logEntry = `${timestamp} ${verificationFlag} ${method} ${url} IP: ${clientIp}`;
      console.log(logEntry);
      
      // Forward to diagnostics if configured
      if (diagnosticsQueue) {
        try {
          await diagnosticsQueue.add('chatgpt-user-access', {
            timestamp,
            method,
            url,
            ip: clientIp,
            verified: isWhitelisted,
            userAgent
          });
        } catch (error) {
          console.error('[CHATGPT-USER] Failed to queue diagnostic log:', error);
        }
      }

      // Apply request policies
      if (method === 'GET') {
        // Always allow GET requests
        return next();
      }

      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
        if (!allowPostMethods) {
          console.log(`[CHATGPT-USER] Denied ${method} request from ${clientIp}`);
          return res.status(405).json({
            error: 'Method not allowed for ChatGPT-User agent',
            allowed: ['GET']
          });
        }

        // Apply rate limiting for non-GET methods if enabled
        if (rateLimit && !isWhitelisted) {
          if (isRateLimited(clientIp)) {
            console.log(`[CHATGPT-USER] Rate limited ${method} request from ${clientIp}`);
            return res.status(429).json({
              error: 'Rate limit exceeded',
              retryAfter: getRemainingTime(clientIp)
            });
          }
        }
      }

      // For unverified requests, add warning header
      if (!isWhitelisted) {
        res.setHeader('X-Verification-Status', 'UNVERIFIED');
        console.warn(`[CHATGPT-USER] ⚠️ Allowing unverified request from ${clientIp}`);
      }
    }

    next();
  };
}

/**
 * Get client IP address, handling proxies
 */
function getClientIP(req: Request): string {
  return (
    req.headers['cf-connecting-ip'] as string ||
    req.headers['x-forwarded-for'] as string ||
    req.headers['x-real-ip'] as string ||
    req.connection?.remoteAddress ||
    req.socket?.remoteAddress ||
    'unknown'
  );
}

/**
 * Check if ChatGPT-User handler is enabled via environment variable
 */
function isEnabled(): boolean {
  const enabled = process.env.ENABLE_GPT_USER_HANDLER;
  return enabled === 'true' || enabled === '1';
}

/**
 * Simple rate limiting implementation
 */
function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitStore.get(ip);

  if (!record || now > record.resetTime) {
    // Reset or create new record
    rateLimitStore.set(ip, {
      count: 1,
      resetTime: now + RATE_LIMIT_WINDOW
    });
    return false;
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  record.count++;
  return false;
}

/**
 * Get remaining time for rate limit reset
 */
function getRemainingTime(ip: string): number {
  const record = rateLimitStore.get(ip);
  if (!record) return 0;
  
  const remaining = Math.max(0, record.resetTime - Date.now());
  return Math.ceil(remaining / 1000); // Return seconds
}

/**
 * Clean up expired rate limit entries (called periodically)
 */
function cleanupRateLimit(): void {
  const now = Date.now();
  for (const [ip, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(ip);
    }
  }
}

// Clean up rate limit store every 5 minutes
setInterval(cleanupRateLimit, 5 * 60 * 1000);

/**
 * Get diagnostic information about the middleware
 */
export function getChatGPTUserDiagnostics() {
  const whitelistStatus = chatGPTUserWhitelist.getCacheStatus();
  
  return {
    enabled: isEnabled(),
    whitelist: whitelistStatus,
    rateLimit: {
      activeIPs: rateLimitStore.size,
      windowMs: RATE_LIMIT_WINDOW,
      maxRequests: RATE_LIMIT_MAX_REQUESTS
    },
    targetUserAgent: CHATGPT_USER_AGENT
  };
}