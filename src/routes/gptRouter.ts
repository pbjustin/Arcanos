import express, { Response } from 'express';
import { getModuleMetadata } from './modules.js';
import getGptModuleMap from "@platform/runtime/gptRouterConfig.js";
import {
  logGptConnection,
  logGptConnectionFailed,
  logGptAckSent,
  type GptMatchMethod,
  type GptRoutingInfo,
} from "@platform/logging/gptLogger.js";
import { runThroughBrain } from '@core/logic/trinity.js';
import { getOpenAIClientOrAdapter } from '@services/openai/clientBridge.js';
import { createRuntimeBudget } from '@platform/resilience/runtimeBudget.js';

const router = express.Router();

declare module 'express-serve-static-core' {
  interface Request {
    gptRoutingContext?: GptRoutingInfo;
  }
}

// Forward any request under /gpt/:gptId to the appropriate module route
router.use('/:gptId', async (req, res, next) => {
  try {
    //audit Assumption: rerouted requests should skip GPT-specific dispatch; risk: double-routing; invariant: rerouted flow continues to safe target; handling: next.
    if (req.dispatchRerouted && req.dispatchDecision === 'reroute') {
      return next();
    }

    const gptModuleMap = await getGptModuleMap();
    const incomingGptId = req.params.gptId;
    if (incomingGptId.length > 256) {
      return res.status(400).json({ error: 'GPTID too long' });
    }
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
            const d: number[][] = Array.from({ length: n + 1 }, () => Array(m + 1).fill(0));
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

    // Route through Trinity pipeline
    //audit Assumption: GPT requests should flow through Trinity for consistency; risk: module-specific logic bypassed; invariant: Trinity processes all GPT routing; handling: build prompt from request body.
    const { action, payload } = req.body as { action?: string; payload?: unknown };
    
    if (!action) {
      return res.status(400).json({ error: 'Action is required' });
    }

    // Build a natural language prompt for Trinity from the GPT request
    const promptParts = [
      `GPT request from ${routingInfo.gptId}`,
      `Target module: ${routingInfo.moduleName} (${entry.route})`,
      `Action: ${action}`,
    ];
    
    if (payload) {
      promptParts.push(`Payload: ${JSON.stringify(payload, null, 2)}`);
    }
    
    const prompt = promptParts.join('\n');
    const sessionId = `gpt-${incomingGptId}-${Date.now()}`;
    
    try {
      const { client: openaiClient } = getOpenAIClientOrAdapter();
      //audit Assumption: Trinity pipeline requires an initialized OpenAI client; failure risk: null client causes downstream crashes; expected invariant: client is non-null before runThroughBrain; handling strategy: fail fast with 503.
      if (!openaiClient) {
        return res.status(503).json({ error: 'OpenAI client not initialized' });
      }
      const runtimeBudget = createRuntimeBudget();
      const trinityResult = await runThroughBrain(openaiClient, prompt, sessionId, undefined, {}, runtimeBudget);
      
      // Build acknowledgment metadata
      const meta = getModuleMetadata(entry.module);
      const ack = {
        gptId: routingInfo.gptId,
        gptDisplayName: routingInfo.moduleName,
        module: routingInfo.moduleName,
        moduleDescription: meta?.description ?? null,
        route: routingInfo.route,
        matchMethod: routingInfo.matchMethod,
        availableActions: meta?.actions ?? [],
        timestamp: new Date().toISOString(),
        routedThroughTrinity: true,
      };
      
      logGptAckSent(routingInfo, ack.availableActions.length);
      
      // Return Trinity result with GPT ack wrapper
      return res.json({
        ...trinityResult,
        _gptAck: ack,
      });
    } catch (trinityErr) {
      //audit Assumption: Trinity failures should return 500; risk: silent failure; invariant: error logged and returned; handling: next(err).
      return next(trinityErr);
    }
  } catch (err) {
    return next(err);
  }
});

export default router;
