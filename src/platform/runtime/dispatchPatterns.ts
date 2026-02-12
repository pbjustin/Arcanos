import { createHash } from 'crypto';
import type { DispatchPatternBindingV9 } from "@shared/types/dispatchV9.js";

/**
 * Purpose: Static dispatch v9 route binding configuration.
 * Inputs/Outputs: No runtime inputs; exports immutable binding list.
 * Edge cases: catch-all binding keeps unmatched /api routes governable.
 */
export const DISPATCH_PATTERN_BINDINGS: DispatchPatternBindingV9[] = [
  {
    id: 'api.ask',
    priority: 120,
    methods: ['POST'],
    exactPaths: ['/api/ask'],
    intentHints: ['ask', 'prompt', 'chat'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    rerouteTarget: '/api/ask',
    expectedRoute: '/api/ask'
  },
  {
    id: 'api.gpt',
    priority: 110,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pathRegexes: ['^/api/gpt(?:/.*)?$', '^/gpt(?:/.*)?$'],
    intentHints: ['gpt', 'module', 'route'],
    sensitivity: 'sensitive',
    // strict_block policies always block on conflict and never reroute, so rerouteTarget is intentionally omitted.
    conflictPolicy: 'strict_block',
    expectedRoute: '/gpt/:gptId'
  },
  {
    id: 'api.modules',
    priority: 100,
    methods: ['POST'],
    exactPaths: ['/api/commands/execute'],
    pathRegexes: ['^/api/modules(?:/.*)?$', '^/api/queryroute$'],
    intentHints: ['module', 'command', 'dispatch'],
    sensitivity: 'sensitive',
    conflictPolicy: 'strict_block',
    expectedRoute: '/api/commands/execute'
  },
  {
    id: 'api.readonly',
    priority: 90,
    methods: ['GET'],
    exactPaths: ['/api/memory/health', '/api/daemon/registry', '/api/test'],
    pathRegexes: ['^/api/(?:health|status)(?:/.*)?$'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    expectedRoute: '/api/read-only'
  },
  {
    id: 'api.default',
    priority: 1,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pathRegexes: ['^/api(?:/.*)?$'],
    intentHints: ['default', 'fallback', 'api'],
    sensitivity: 'non-sensitive',
    conflictPolicy: 'refresh_then_reroute',
    rerouteTarget: '/api/ask',
    expectedRoute: '*'
  }
];

/**
 * Purpose: List routes that bypass v9 consistency enforcement.
 * Inputs/Outputs: No inputs; returns immutable route/method descriptors.
 * Edge cases: prefix rules support read-only namespaces.
 */
export const DISPATCH_V9_EXEMPT_ROUTES: Array<{
  method: string;
  exactPath?: string;
  prefixPath?: string;
}> = [
  { method: 'GET', exactPath: '/api/test' },
  { method: 'GET', exactPath: '/api/memory/health' },
  { method: 'GET', exactPath: '/api/daemon/registry' },
  { method: 'GET', prefixPath: '/api/health' },
  { method: 'GET', prefixPath: '/api/status' }
];

/**
 * Purpose: Build deterministic version hash for static bindings.
 * Inputs/Outputs: binding list; returns sha256 hex digest.
 * Edge cases: stable serialization avoids non-deterministic key order issues.
 */
export function getDispatchBindingsVersion(
  bindings: DispatchPatternBindingV9[] = DISPATCH_PATTERN_BINDINGS
): string {
  const stable = JSON.stringify(bindings.map(binding => ({
    ...binding,
    methods: [...binding.methods].sort(),
    exactPaths: binding.exactPaths ? [...binding.exactPaths].sort() : undefined,
    pathRegexes: binding.pathRegexes ? [...binding.pathRegexes].sort() : undefined,
    pathTemplates: binding.pathTemplates ? [...binding.pathTemplates].sort() : undefined,
    intentHints: binding.intentHints ? [...binding.intentHints].sort() : undefined
  })));
  return createHash('sha256').update(stable).digest('hex');
}

export const DISPATCH_BINDINGS_VERSION = getDispatchBindingsVersion();

