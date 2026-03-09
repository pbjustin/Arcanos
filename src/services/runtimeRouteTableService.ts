/**
 * Runtime route table helpers for canonical ARCANOS public APIs.
 */

import type { Application } from 'express';

const CANONICAL_PUBLIC_PREFIXES = [
  '/api/health',
  '/api/diagnostics',
  '/api/sessions'
];

interface ExpressRouteLayer {
  route?: {
    path?: string | string[];
    methods?: Record<string, boolean>;
  };
  handle?: {
    stack?: ExpressRouteLayer[];
  };
}

function isCanonicalPublicRoute(pathname: string): boolean {
  return CANONICAL_PUBLIC_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

function collectRouteEntriesFromStack(
  stack: ExpressRouteLayer[],
  collector: Set<string>
): void {
  for (const layer of stack) {
    const route = layer.route;
    if (route?.path) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const methods = Object.entries(route.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase());

      for (const pathname of paths) {
        if (typeof pathname !== 'string' || !isCanonicalPublicRoute(pathname)) {
          continue;
        }

        for (const method of methods) {
          collector.add(`${method} ${pathname}`);
        }
      }
    }

    const nestedStack = layer.handle?.stack;
    if (Array.isArray(nestedStack)) {
      collectRouteEntriesFromStack(nestedStack, collector);
    }
  }
}

/**
 * Collect the canonical public route table from the live Express runtime.
 *
 * Purpose:
 * - Back `/api/health/routes` with a machine-verifiable route table derived from mounted handlers.
 *
 * Inputs/outputs:
 * - Input: Express app instance.
 * - Output: sorted route table entries in `METHOD /path` form.
 *
 * Edge case behavior:
 * - Returns an empty array when the app router stack is unavailable.
 */
export function getCanonicalPublicRouteTable(app: Application): string[] {
  const rootRouter = (app as Application & { _router?: { stack?: ExpressRouteLayer[] } })._router;
  const routeStack = rootRouter?.stack;

  //audit Assumption: route introspection must fail closed when the Express stack is unavailable; failure risk: `/api/health/routes` invents routes instead of reflecting mounted handlers; expected invariant: only mounted routes are returned; handling strategy: return an empty array when the stack cannot be inspected.
  if (!Array.isArray(routeStack)) {
    return [];
  }

  const collector = new Set<string>();
  collectRouteEntriesFromStack(routeStack, collector);
  return Array.from(collector).sort((left, right) => left.localeCompare(right));
}
