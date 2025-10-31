import type { Request, Response, NextFunction, RequestHandler } from 'express';
import axios from 'axios';
import ipaddr from 'ipaddr.js';
import env from '../utils/env.js';
import { logger } from '../utils/structuredLogging.js';

const OPENAI_CHATGPT_IP_ENDPOINT = 'https://openai.com/chatgpt-user.json';
const CACHE_REFRESH_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 60 seconds
const RATE_LIMIT_MAX_REQUESTS = 10;
const TARGET_USER_AGENT_FRAGMENT = 'ChatGPT-User';

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface IpWhitelistCache {
  prefixes: string[];
  lastFetch: number | null;
  lastError?: string;
}

export interface ChatGPTUserStatus {
  enabled: boolean;
  whitelist: {
    lastFetch: number | null;
    isStale: boolean;
    prefixCount: number;
    lastError?: string;
  };
  rateLimit: {
    activeIPs: number;
    windowMs: number;
    maxRequests: number;
  };
  targetUserAgent: string;
  timestamp: string;
}

export interface ChatGPTUserOptions {
  /** Allow POST/PUT requests from the ChatGPT-User agent */
  allowPostMethods?: boolean;
  /** Enable rate limiting for unverified requests */
  rateLimit?: boolean;
  /** Optional diagnostics callback queue (reserved for future use) */
  diagnosticsQueue?: { push: (entry: Record<string, unknown>) => void };
}

const ipWhitelistCache: IpWhitelistCache = {
  prefixes: [],
  lastFetch: null
};

const rateLimitBuckets = new Map<string, RateLimitBucket>();
let ongoingFetch: Promise<void> | null = null;

function isCacheStale(): boolean {
  if (!ipWhitelistCache.lastFetch) {
    return true;
  }
  return Date.now() - ipWhitelistCache.lastFetch > CACHE_REFRESH_INTERVAL_MS;
}

async function refreshIpWhitelist(force = false): Promise<void> {
  if (!force && !isCacheStale() && ipWhitelistCache.prefixes.length > 0) {
    return;
  }

  if (!ongoingFetch) {
    ongoingFetch = axios
      .get<{ prefixes?: string[] }>(OPENAI_CHATGPT_IP_ENDPOINT, { timeout: 5000 })
      .then(response => {
        const prefixes = response.data?.prefixes;
        if (!Array.isArray(prefixes) || prefixes.length === 0) {
          throw new Error('IP whitelist response missing prefixes array');
        }
        ipWhitelistCache.prefixes = prefixes;
        ipWhitelistCache.lastFetch = Date.now();
        delete ipWhitelistCache.lastError;
      })
      .catch(error => {
        const message = error instanceof Error ? error.message : 'Unknown error fetching whitelist';
        ipWhitelistCache.lastError = message;
        logger.warn('Failed to refresh ChatGPT IP whitelist', {
          module: 'security',
          operation: 'chatgpt-user-ip-fetch'
        }, { error: message });
      })
      .finally(() => {
        ongoingFetch = null;
      });
  }

  try {
    await ongoingFetch;
  } catch (error) {
    // Errors already logged above; fall back to cached prefixes
    logger.debug('Using cached ChatGPT IP whitelist after fetch failure', {
      module: 'security',
      operation: 'chatgpt-user-ip-cache'
    }, error instanceof Error ? { error: error.message } : undefined);
  }
}

function normalizeIp(ip: string | undefined): string {
  if (!ip) {
    return '';
  }

  const rawIp = ip.split(',')[0].trim();

  try {
    const parsed = ipaddr.parse(rawIp);
    if (parsed.kind() === 'ipv6' && parsed.isIPv4MappedAddress()) {
      return parsed.toIPv4Address().toString();
    }
    return parsed.toNormalizedString();
  } catch {
    return rawIp;
  }
}

function extractClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return normalizeIp(forwarded);
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return normalizeIp(forwarded[0]);
  }
  return normalizeIp(req.ip || req.socket.remoteAddress || '');
}

function isIpInWhitelist(ip: string): boolean {
  if (!ip || ipWhitelistCache.prefixes.length === 0) {
    return false;
  }

  try {
    const address = ipaddr.parse(ip);
    return ipWhitelistCache.prefixes.some(prefix => {
      try {
        const [range, bits] = prefix.split('/');
        if (!range || !bits) {
          return false;
        }
        const network = ipaddr.parse(range);
        const subnet = parseInt(bits, 10);
        if (Number.isNaN(subnet)) {
          return false;
        }
        if (network.kind() !== address.kind()) {
          // Normalize IPv4 mapped IPv6 addresses to IPv4 for comparison
          if (address.kind() === 'ipv6' && address.isIPv4MappedAddress()) {
            const v4Address = address.toIPv4Address();
            if (network.kind() === 'ipv4') {
              return v4Address.match(network, subnet);
            }
          }
          return false;
        }
        return address.match(network, subnet);
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isChatGPTUserAgent(userAgent: string | undefined): boolean {
  if (!userAgent) {
    return false;
  }
  return userAgent.includes(TARGET_USER_AGENT_FRAGMENT);
}

function shouldBlockMethod(method: string, allowPostMethods: boolean): boolean {
  if (allowPostMethods) {
    return false;
  }
  return method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
}

function applyRateLimit(ip: string): boolean {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(ip);

  if (!bucket || bucket.resetAt <= now) {
    bucket = {
      count: 0,
      resetAt: now + RATE_LIMIT_WINDOW_MS
    };
    rateLimitBuckets.set(ip, bucket);
  }

  bucket.count += 1;

  if (bucket.count > RATE_LIMIT_MAX_REQUESTS) {
    return true;
  }

  return false;
}

function logChatGPTRequest(metadata: Record<string, unknown>): void {
  logger.info('ChatGPT-User request processed', {
    module: 'security',
    operation: 'chatgpt-user-request'
  }, metadata);
}

export function getChatGPTUserStatus(): ChatGPTUserStatus {
  return {
    enabled: env.ENABLE_GPT_USER_HANDLER,
    whitelist: {
      lastFetch: ipWhitelistCache.lastFetch,
      isStale: isCacheStale(),
      prefixCount: ipWhitelistCache.prefixes.length,
      lastError: ipWhitelistCache.lastError
    },
    rateLimit: {
      activeIPs: rateLimitBuckets.size,
      windowMs: RATE_LIMIT_WINDOW_MS,
      maxRequests: RATE_LIMIT_MAX_REQUESTS
    },
    targetUserAgent: TARGET_USER_AGENT_FRAGMENT,
    timestamp: new Date().toISOString()
  };
}

export function chatGPTUserMiddleware(options: ChatGPTUserOptions = {}): RequestHandler {
  const allowPostMethods = options.allowPostMethods ?? false;
  const enableRateLimit = options.rateLimit ?? true;

  return async function chatGPTUserHandler(req: Request, res: Response, next: NextFunction) {
    if (!env.ENABLE_GPT_USER_HANDLER) {
      return next();
    }

    const userAgent = req.get('user-agent');
    const isChatGPT = isChatGPTUserAgent(userAgent);

    if (!isChatGPT) {
      return next();
    }

    await refreshIpWhitelist();

    const clientIp = extractClientIp(req);
    const verified = isIpInWhitelist(clientIp);

    const metadata = {
      method: req.method,
      path: req.originalUrl,
      userAgent,
      clientIp,
      verified
    };

    if (shouldBlockMethod(req.method, allowPostMethods)) {
      logChatGPTRequest({ ...metadata, action: 'blocked_method' });
      return res.status(405).json({
        error: 'Method not allowed for ChatGPT-User agent',
        allowedMethods: ['GET']
      });
    }

    if (enableRateLimit && !verified) {
      const limited = applyRateLimit(clientIp || 'unknown');
      if (limited) {
        logChatGPTRequest({ ...metadata, action: 'rate_limited' });
        res.setHeader('Retry-After', Math.ceil(RATE_LIMIT_WINDOW_MS / 1000).toString());
        return res.status(429).json({
          error: 'Too many requests from ChatGPT-User agent. Please retry later.'
        });
      }
    }

    logChatGPTRequest({ ...metadata, action: verified ? 'allowed_verified' : 'allowed_unverified' });
    return next();
  };
}

export function resetChatGPTUserRateLimit(): void {
  rateLimitBuckets.clear();
}

