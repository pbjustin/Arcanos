import express from 'express';
import { resolveSession } from "@services/sessionResolver.js";
import { asyncHandler, sendInternalErrorPayload } from '@shared/http/index.js';
import { listUserSessions } from '@services/sessionCatalogService.js';
import { handleReplayRequest } from './ask/replay.js';

const router = express.Router();

/**
 * Resolve and bound a numeric session list limit from query parameters.
 * Inputs/outputs: raw query value -> positive integer limit or undefined for service default.
 * Edge cases: invalid values defer to the service default.
 */
function resolveSessionListLimit(rawLimit: unknown): number | undefined {
  const firstValue = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
  const parsedLimit = Number.parseInt(typeof firstValue === 'string' || typeof firstValue === 'number' ? String(firstValue) : '', 10);

  //audit Assumption: invalid query limits should not fail the session list endpoint; failure risk: route-level 400s for harmless UI input noise; expected invariant: session list falls back to default bounds; handling strategy: return undefined so the service applies its default.
  if (!Number.isInteger(parsedLimit) || parsedLimit <= 0) {
    return undefined;
  }

  return parsedLimit;
}

/**
 * Normalize optional session search text from query parameters.
 * Inputs/outputs: raw query value -> trimmed search string or null.
 * Edge cases: empty values disable filtering.
 */
function resolveSessionListSearch(rawSearch: unknown): string | null {
  const firstValue = Array.isArray(rawSearch) ? rawSearch[0] : rawSearch;
  if (typeof firstValue !== 'string') {
    return null;
  }

  const normalized = firstValue.trim();
  return normalized.length > 0 ? normalized : null;
}

router.get('/sessions', asyncHandler(async (req, res) => {
  const sessions = await listUserSessions({
    limit: resolveSessionListLimit(req.query.limit),
    search: resolveSessionListSearch(req.query.q)
  });

  res.json({
    status: 'success',
    message: 'Sessions retrieved',
    data: {
      count: sessions.length,
      sessions
    }
  });
}));

router.post('/sessions/:sessionId/replay', asyncHandler(handleReplayRequest));

router.post('/memory/resolve', asyncHandler(async (req, res) => {
  try {
    const { query } = req.body as { query: string };
    const result = await resolveSession(query);
    res.json(result);
  } catch (err) {
    sendInternalErrorPayload(res, { error: 'Failed to resolve session', details: err });
  }
}));

export default router;
