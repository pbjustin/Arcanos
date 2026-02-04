import express, { Request, Response } from 'express';
import modulesRouter, { getModuleMetadata } from './modules.js';
import getGptModuleMap from '../config/gptRouterConfig.js';
import {
  logGptConnection,
  logGptConnectionFailed,
  logGptAckSent,
  type GptMatchMethod,
  type GptRoutingInfo,
} from '../utils/gptLogger.js';

const router = express.Router();

declare module 'express-serve-static-core' {
  interface Request {
    gptRoutingContext?: GptRoutingInfo;
  }
}

// Forward any request under /gpt/:gptId to the appropriate module route
router.use('/:gptId', async (req, res, next) => {
  try {
    const gptModuleMap = await getGptModuleMap();
    const incomingGptId = req.params.gptId;
    const configuredGptIds = Object.keys(gptModuleMap);

    // Matching strategy (flexible):
    // 1. Exact match
    // 2. Longest configured id substring match
    // 3. Token-subset match (configured id tokens mostly appear in incoming id)
    // 4. Fuzzy match via Levenshtein distance with a small threshold
    const normalize = (s: string) => (s || '').toLowerCase().trim();
    const stripNonAlnum = (s: string) => normalize(s).replace(/[^a-z0-9]+/g, '');

    let entry;
    let matchMethod: GptMatchMethod = 'none';

    const exact = configuredGptIds.find(id => id === incomingGptId);
    if (exact) {
      entry = gptModuleMap[exact];
      matchMethod = 'exact';
    } else {
      // Longest substring match (prefer longer configured ids first)
      const sortedIds = [...configuredGptIds].sort((a, b) => b.length - a.length);
      const substrMatch = sortedIds.find(id => incomingGptId.includes(id));
      if (substrMatch) {
        entry = gptModuleMap[substrMatch];
        matchMethod = 'substring';
      } else {
        // Token-subset heuristic
        const incomingTokens = new Set(normalize(incomingGptId).split(/[^a-z0-9]+/).filter(Boolean));
        let tokenMatchId: string | undefined;
        for (const id of configuredGptIds) {
          const tokens = normalize(id).split(/[^a-z0-9]+/).filter(Boolean);
          if (!tokens.length) continue;
          const common = tokens.filter(t => incomingTokens.has(t)).length;
          const ratio = common / tokens.length;
          if (ratio >= 0.6) { // majority of tokens present
            tokenMatchId = id;
            break;
          }
        }

        if (tokenMatchId) {
          entry = gptModuleMap[tokenMatchId];
          matchMethod = 'token-subset';
        } else {
          // Fuzzy Levenshtein fallback
          const lev = (a: string, b: string) => {
            const A = stripNonAlnum(a);
            const B = stripNonAlnum(b);
            const n = A.length, m = B.length;
            if (n === 0) return m;
            if (m === 0) return n;
            const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array(m + 1).fill(0));
            for (let i = 0; i <= n; i++) d[i][0] = i;
            for (let j = 0; j <= m; j++) d[0][j] = j;
            for (let i = 1; i <= n; i++) {
              for (let j = 1; j <= m; j++) {
                const cost = A[i - 1] === B[j - 1] ? 0 : 1;
                d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
              }
            }
            return d[n][m];
          };

          let bestId: string | undefined;
          let bestScore = Infinity;
          for (const id of configuredGptIds) {
            const distance = lev(incomingGptId, id);
            if (distance < bestScore) {
              bestScore = distance;
              bestId = id;
            }
          }
          if (bestId) {
            const threshold = Math.max(2, Math.floor(bestId.length * 0.25));
            if (bestScore <= threshold) {
              entry = gptModuleMap[bestId];
              matchMethod = 'fuzzy';
            }
          }
        }
      }
    }

    if (!entry) {
      logGptConnectionFailed(incomingGptId);
      return res.status(404).json({ error: 'Unknown GPTID' });
    }

    // Build routing context
    const routingInfo: GptRoutingInfo = {
      gptId: incomingGptId,
      moduleName: entry.module,
      route: entry.route,
      matchMethod,
    };

    // Log the connection
    logGptConnection(routingInfo);

    // Attach to request (same pattern as confirmGate.ts confirmationContext)
    req.gptRoutingContext = routingInfo;

    // Intercept res.json to wrap the response with acknowledgment metadata
    const originalJson = res.json.bind(res);
    (res as Response).json = function wrappedJson(body: unknown) {
      // Only enrich successful responses (not error payloads from modules.ts)
      if (res.statusCode >= 400) {
        return originalJson(body);
      }

      // Look up module metadata for the acknowledgment
      const meta = getModuleMetadata(entry!.module);
      const ack = {
        gptId: routingInfo.gptId,
        gptDisplayName: routingInfo.moduleName,
        module: routingInfo.moduleName,
        moduleDescription: meta?.description ?? null,
        route: routingInfo.route,
        matchMethod: routingInfo.matchMethod,
        availableActions: meta?.actions ?? [],
        timestamp: new Date().toISOString(),
      };

      logGptAckSent(routingInfo, ack.availableActions.length);

      // Wrap response: preserve original data, add _gptAck
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        return originalJson({ ...body as Record<string, unknown>, _gptAck: ack });
      } else {
        return originalJson({ result: body, _gptAck: ack });
      }
    } as typeof res.json;

    // Ensure body exists so downstream handlers can attach module metadata
    if (!req.body) {
      req.body = {};
    }

    req.url = `/modules/${entry.route}`;
    req.body.module = entry.module;
    return modulesRouter(req, res, next);
  } catch (err) {
    return next(err);
  }
});

export default router;
