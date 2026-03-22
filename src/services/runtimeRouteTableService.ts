/**
 * Runtime route table helpers for canonical ARCANOS public APIs.
 */

import type { Application } from 'express';

const CANONICAL_PUBLIC_PREFIXES = [
  '/api/agent',
  '/api/health',
  '/api/diagnostics',
  '/api/sessions'
];

interface ExpressRouteLayer {
  name?: string;
  regexp?: {
    fast_slash?: boolean;
    source?: string;
  };
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
  collector: Set<string>,
  prefix = '',
  shouldIncludeRoute: (pathname: string) => boolean = () => true
): void {
  for (const layer of stack) {
    const route = layer.route;
    if (route?.path) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      const methods = Object.entries(route.methods ?? {})
        .filter(([, enabled]) => enabled)
        .map(([method]) => method.toUpperCase());

      for (const pathname of paths) {
        if (typeof pathname !== 'string') {
          continue;
        }

        const resolvedPathname = joinRoutePath(prefix, pathname);
        if (!shouldIncludeRoute(resolvedPathname)) {
          continue;
        }

        for (const method of methods) {
          collector.add(`${method} ${resolvedPathname}`);
        }
      }
    }

    const nestedStack = layer.handle?.stack;
    if (Array.isArray(nestedStack)) {
      collectRouteEntriesFromStack(
        nestedStack,
        collector,
        joinRoutePath(prefix, decodeMountPath(layer)),
        shouldIncludeRoute
      );
    }
  }
}

function joinRoutePath(prefix: string, pathname: string): string {
  const normalizedPrefix = normalizeRoutePath(prefix);
  const normalizedPath = normalizeRoutePath(pathname);

  if (!normalizedPrefix) {
    return normalizedPath || '/';
  }

  if (!normalizedPath || normalizedPath === '/') {
    return normalizedPrefix;
  }

  return normalizeRoutePath(`${normalizedPrefix}/${normalizedPath}`);
}

function normalizeRoutePath(pathname: string): string {
  if (!pathname || pathname === '/') {
    return pathname ? '/' : '';
  }

  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

function decodeMountPath(layer: ExpressRouteLayer): string {
  const regexpSource = layer.regexp?.source ?? '';
  if (layer.regexp?.fast_slash || regexpSource === '^\\/?(?=\\/|$)') {
    return '';
  }

  // Express does not expose mount paths directly on nested layers, so this decodes the
  // framework's current regexp serialization. If Express changes that internal format,
  // route-table diagnostics here will need to be updated alongside the framework upgrade.
  const decoded = regexpSource
    .replace(/\\\/\?\(\?=\\\/\|\$\)/g, '')
    .replace(/\(\?=\\\/\|\$\)/g, '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\\\//g, '/')
    .replace(/\\\./g, '.');

  if (!decoded || decoded === '/') {
    return '';
  }

  return normalizeRoutePath(decoded);
}

function getRouteTable(
  app: Application,
  shouldIncludeRoute: (pathname: string) => boolean
): string[] {
  const rootRouter = (app as Application & { _router?: { stack?: ExpressRouteLayer[] } })._router;
  const routeStack = rootRouter?.stack;

  if (!Array.isArray(routeStack)) {
    return [];
  }

  const collector = new Set<string>();
  collectRouteEntriesFromStack(routeStack, collector, '', shouldIncludeRoute);
  return Array.from(collector).sort((left, right) => left.localeCompare(right));
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
  return getRouteTable(app, (pathname) => isCanonicalPublicRoute(pathname));
}

/**
 * Collect the full live route table from the mounted Express runtime.
 *
 * Purpose:
 * - Back runtime diagnostics with measurable route data from the active app instance.
 *
 * Inputs/outputs:
 * - Input: Express app instance.
 * - Output: sorted route table entries in `METHOD /path` form.
 *
 * Edge case behavior:
 * - Returns an empty array when the Express stack is unavailable.
 */
export function getActiveRouteTable(app: Application): string[] {
  return getRouteTable(app, () => true);
}
