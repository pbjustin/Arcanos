import { describe, expect, it } from '@jest/globals';

import {
  DISPATCH_PATTERN_BINDINGS,
  DISPATCH_V9_EXEMPT_ROUTES,
} from '../src/platform/runtime/dispatchPatterns.js';
import { resolveBinding } from '../src/services/dispatchControllerV9.js';
import type { DispatchAttemptV9 } from '../src/shared/types/dispatchV9.js';

function createAttempt(method: string, path: string): DispatchAttemptV9 {
  return {
    method,
    path,
    routeAttempted: `${method} ${path}`,
    intentHints: [],
    requestId: 'req-cef-routing-authority',
    traceId: 'trace-cef-routing-authority',
  };
}

describe('CEF dispatch routing authority', () => {
  it.each([
    ['/api/agent/execute', 'api.agent-execution'],
    ['/api/agent/execute/', 'api.agent-execution'],
    ['/api/commands/execute', 'api.modules'],
    ['/api/commands/execute/', 'api.modules'],
  ])('strictly binds POST %s to %s', (path, bindingId) => {
    const binding = resolveBinding(
      createAttempt('POST', path),
      DISPATCH_PATTERN_BINDINGS
    );

    expect(binding).toEqual(expect.objectContaining({
      id: bindingId,
      sensitivity: 'sensitive',
      conflictPolicy: 'strict_block',
    }));
  });

  it.each(['GET', 'HEAD'])(
    'exempts command registry %s reads from writing-plane rerouting',
    (method) => {
      for (const path of [
        '/api/commands',
        '/api/commands/',
        '/api/commands/health',
        '/api/commands/health/',
      ]) {
        expect(DISPATCH_V9_EXEMPT_ROUTES).toContainEqual({
          method,
          exactPath: path,
        });
      }
    }
  );
});
