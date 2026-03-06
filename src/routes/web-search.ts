import express from 'express';
import { z } from 'zod';
import { createRateLimitMiddleware, createValidationMiddleware, securityHeaders } from '@platform/runtime/security.js';
import { asyncHandler } from '@shared/http/index.js';
import { webSearchAgent } from '@services/webSearchAgent.js';
import { resolveErrorMessage } from '@core/lib/errors/index.js';
import { getEnvNumber } from '@platform/runtime/env.js';

const router = express.Router();

const rawBodySchema = {
  query: { type: 'string' as const, required: true, minLength: 1, maxLength: 1000, sanitize: true },
  provider: { type: 'string' as const, required: false, maxLength: 40, sanitize: true },
  limit: { type: 'number' as const, required: false },
  fetchPages: { type: 'number' as const, required: false },
  pageMaxChars: { type: 'number' as const, required: false },
  includePageContent: { type: 'boolean' as const, required: false },
  synthesize: { type: 'boolean' as const, required: false },
  synthesisModel: { type: 'string' as const, required: false, maxLength: 120, sanitize: true },
  allowDomains: { type: 'array' as const, required: false },
  denyDomains: { type: 'array' as const, required: false },
  traverseLinks: { type: 'boolean' as const, required: false },
  traversalDepth: { type: 'number' as const, required: false },
  maxTraversalPages: { type: 'number' as const, required: false },
  sameDomainOnly: { type: 'boolean' as const, required: false },
  traversalLinkLimit: { type: 'number' as const, required: false }
};

const requestSchema = z.object({
  query: z.string().min(1).max(1000),
  provider: z.enum(['auto', 'duckduckgo-lite', 'brave', 'tavily', 'serpapi', 'searxng']).optional(),
  limit: z.number().int().min(1).max(10).optional(),
  fetchPages: z.number().int().min(1).max(5).optional(),
  pageMaxChars: z.number().int().min(1000).max(12000).optional(),
  includePageContent: z.boolean().optional(),
  synthesize: z.boolean().optional(),
  synthesisModel: z.string().min(1).max(120).optional(),
  allowDomains: z.array(z.string().min(1).max(255)).max(50).optional(),
  denyDomains: z.array(z.string().min(1).max(255)).max(50).optional(),
  traverseLinks: z.boolean().optional(),
  traversalDepth: z.number().int().min(1).max(2).optional(),
  maxTraversalPages: z.number().int().min(1).max(5).optional(),
  sameDomainOnly: z.boolean().optional(),
  traversalLinkLimit: z.number().int().min(1).max(8).optional()
});

const maxRequests = Math.max(1, Math.floor(getEnvNumber('WEB_SEARCH_RATE_LIMIT_MAX', 30)));
const windowMs = Math.max(1000, Math.floor(getEnvNumber('WEB_SEARCH_RATE_LIMIT_WINDOW_MS', 10 * 60 * 1000)));

router.use(securityHeaders);
router.use('/api/web/search', createRateLimitMiddleware(maxRequests, windowMs));

router.post(
  '/api/web/search',
  createValidationMiddleware(rawBodySchema),
  asyncHandler(async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    //audit Assumption: body sanitization and structural validation may still leave semantic bound violations; failure risk: invalid traversal/search limits reach the service layer; expected invariant: only zod-validated payloads call the agent; handling strategy: return a standardized 400 with issue details.
    if (!parsed.success) {
      res.status(400).json({
        error: 'Validation failed',
        details: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`),
        timestamp: new Date().toISOString()
      });
      return;
    }

    try {
      const result = await webSearchAgent(parsed.data.query, {
        provider: parsed.data.provider,
        limit: parsed.data.limit,
        fetchPages: parsed.data.fetchPages,
        pageMaxChars: parsed.data.pageMaxChars,
        includePageContent: parsed.data.includePageContent,
        synthesize: parsed.data.synthesize,
        synthesisModel: parsed.data.synthesisModel,
        allowDomains: parsed.data.allowDomains,
        denyDomains: parsed.data.denyDomains,
        traverseLinks: parsed.data.traverseLinks,
        traversalDepth: parsed.data.traversalDepth,
        maxTraversalPages: parsed.data.maxTraversalPages,
        sameDomainOnly: parsed.data.sameDomainOnly,
        traversalLinkLimit: parsed.data.traversalLinkLimit
      });

      res.json({
        ok: true,
        ...result
      });
    } catch (error) {
      //audit Assumption: upstream search/provider failures are operational errors, not validation errors; failure risk: leaking internal stack details; expected invariant: client gets a stable failure contract; handling strategy: map to WEB_SEARCH_FAILED with resolved message only.
      res.status(500).json({
        ok: false,
        error: 'WEB_SEARCH_FAILED',
        message: resolveErrorMessage(error),
        timestamp: new Date().toISOString()
      });
    }
  })
);

export default router;
