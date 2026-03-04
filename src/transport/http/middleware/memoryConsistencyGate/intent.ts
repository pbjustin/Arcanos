import type { Request } from 'express';
import type { DispatchAttemptV9, DispatchConflictReasonV9 } from '@shared/types/dispatchV9.js';
import { normalizePath } from './utils.js';

export function readIntentHints(req: Request): string[] {
  const body = req.body as Record<string, unknown> | undefined;
  if (!body || typeof body !== 'object') {
    return [];
  }

  const hints: string[] = [];
  const candidates = [body.domain, body.module, body.command, body.updateType, body.source];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      hints.push(candidate.trim().toLowerCase());
    }
  }

  return Array.from(new Set(hints));
}

export function buildRouteAttempt(req: Request): DispatchAttemptV9 {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);
  return {
    method,
    path,
    routeAttempted: `${method} ${path}`,
    intentHints: readIntentHints(req)
  };
}

export function buildRerouteMessage(
  req: Request,
  routeAttempted: string,
  conflictReason: DispatchConflictReasonV9
): string {
  const body = req.body as Record<string, unknown> | undefined;
  const candidates = [body?.message, body?.prompt, body?.userInput, body?.content, body?.text, body?.query];

  for (const candidate of candidates) {
    //audit Assumption: existing textual prompt should be preserved when rerouting; risk: losing user intent; invariant: first non-empty prompt reused; handling: return candidate.
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return `Dispatch reroute request for ${routeAttempted}. Conflict reason: ${conflictReason}.`;
}
