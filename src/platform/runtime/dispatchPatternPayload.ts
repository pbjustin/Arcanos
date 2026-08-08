import type { DispatchPatternBindingV9 } from '@shared/types/dispatchV9.js';

/** Static Dispatch v9 route bindings used by runtime enforcement and digest tooling. */
export const DISPATCH_PATTERN_BINDINGS: DispatchPatternBindingV9[] = [
  {
    id: 'api.gpt',
    priority: 120,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pathRegexes: ['^/api/gpt(?:/.*)?$', '^/gpt(?:/.*)?$'],
    intentHints: ['gpt', 'module', 'route'],
    sensitivity: 'sensitive',
    // strict_block policies always block on conflict and never reroute, so rerouteTarget is intentionally omitted.
    conflictPolicy: 'strict_block',
    expectedRoute: '/gpt/:gptId'
  },
  {
    id: 'api.agent-execution',
    priority: 110,
    methods: ['POST'],
    exactPaths: ['/api/agent/execute'],
    pathRegexes: ['^/api/agent/execute/?$'],
    sensitivity: 'sensitive',
    conflictPolicy: 'strict_block',
    expectedRoute: '/api/agent/execute'
  },
  {
    id: 'api.afol-decision',
    priority: 105,
    methods: ['POST'],
    exactPaths: ['/api/afol/decide'],
    pathRegexes: ['^/api/afol/decide/?$'],
    sensitivity: 'sensitive',
    conflictPolicy: 'strict_block',
    expectedRoute: '/api/afol/decide'
  },
  {
    id: 'api.modules',
    priority: 100,
    methods: ['POST'],
    exactPaths: ['/api/commands/execute'],
    pathRegexes: [
      '^/api/commands/execute/?$',
      '^/api/modules(?:/.*)?$',
      '^/api/queryroute$'
    ],
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
    rerouteTarget: '/gpt/arcanos-daemon',
    expectedRoute: '*'
  }
];

/** Routes that intentionally bypass Dispatch v9 consistency enforcement. */
export const DISPATCH_V9_EXEMPT_ROUTES: Array<{
  method: string;
  exactPath?: string;
  prefixPath?: string;
}> = [
  { method: 'GET', exactPath: '/api/test' },
  { method: 'GET', exactPath: '/api/commands' },
  { method: 'GET', exactPath: '/api/commands/' },
  { method: 'GET', exactPath: '/api/commands/health' },
  { method: 'GET', exactPath: '/api/commands/health/' },
  { method: 'HEAD', exactPath: '/api/commands' },
  { method: 'HEAD', exactPath: '/api/commands/' },
  { method: 'HEAD', exactPath: '/api/commands/health' },
  { method: 'HEAD', exactPath: '/api/commands/health/' },
  { method: 'GET', exactPath: '/api/afol/health' },
  { method: 'GET', exactPath: '/api/afol/health/' },
  { method: 'GET', exactPath: '/api/afol/logs' },
  { method: 'GET', exactPath: '/api/afol/logs/' },
  { method: 'GET', exactPath: '/api/afol/analytics' },
  { method: 'GET', exactPath: '/api/afol/analytics/' },
  { method: 'HEAD', exactPath: '/api/afol/health' },
  { method: 'HEAD', exactPath: '/api/afol/health/' },
  { method: 'HEAD', exactPath: '/api/afol/logs' },
  { method: 'HEAD', exactPath: '/api/afol/logs/' },
  { method: 'HEAD', exactPath: '/api/afol/analytics' },
  { method: 'HEAD', exactPath: '/api/afol/analytics/' },
  { method: 'GET', exactPath: '/api/memory/health' },
  { method: 'GET', exactPath: '/api/daemon/registry' },
  { method: 'GET', prefixPath: '/api/health' },
  { method: 'GET', prefixPath: '/api/status' }
];

/** Return the exact protected payload, including both bindings and exemptions. */
export function getDispatchPatternIntegrityPayload(): {
  bindings: DispatchPatternBindingV9[];
  exemptRoutes: typeof DISPATCH_V9_EXEMPT_ROUTES;
} {
  return {
    bindings: DISPATCH_PATTERN_BINDINGS,
    exemptRoutes: DISPATCH_V9_EXEMPT_ROUTES
  };
}
