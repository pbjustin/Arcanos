import express from 'express';
import modulesRouter from './modules.js';
import getGptModuleMap from '../config/gptRouterConfig.js';

const router = express.Router();

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
    const exact = configuredGptIds.find(id => id === incomingGptId);
    if (exact) {
      entry = gptModuleMap[exact];
    } else {
      // Longest substring match (prefer longer configured ids first)
      const sortedIds = [...configuredGptIds].sort((a, b) => b.length - a.length);
      const substrMatch = sortedIds.find(id => incomingGptId.includes(id));
      if (substrMatch) {
        entry = gptModuleMap[substrMatch];
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
            }
          }
        }
      }
    }

    if (!entry) {
      return res.status(404).json({ error: 'Unknown GPTID' });
    }

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
