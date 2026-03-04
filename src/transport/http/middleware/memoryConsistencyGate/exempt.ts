import type { Request } from 'express';
import { DISPATCH_V9_EXEMPT_ROUTES } from '@platform/runtime/dispatchPatterns.js';
import { normalizePath } from './utils.js';

export function isExemptRoute(req: Request): boolean {
  const method = req.method.toUpperCase();
  const path = normalizePath(req.path);

  for (const exemption of DISPATCH_V9_EXEMPT_ROUTES) {
    //audit Assumption: exemption method must match to avoid over-bypass; risk: skipping required checks; invariant: method equality; handling: continue when mismatch.
    if (method !== exemption.method.toUpperCase()) {
      continue;
    }
    //audit Assumption: exact path exemptions are strongest bypass signal; risk: stale exact route; invariant: exact equality required; handling: return true.
    if (exemption.exactPath && normalizePath(exemption.exactPath) === path) {
      return true;
    }
    //audit Assumption: prefix exemptions cover read-only route families; risk: broad bypass; invariant: prefix bounded by path boundary; handling: return true on exact or slash-delimited match.
    const normalizedPrefix = exemption.prefixPath ? normalizePath(exemption.prefixPath) : undefined;
    if (normalizedPrefix && (path === normalizedPrefix || path.startsWith(`${normalizedPrefix}/`))) {
      return true;
    }
  }

  return false;
}
