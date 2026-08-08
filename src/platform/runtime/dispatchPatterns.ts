import { createHash } from 'crypto';
import type { DispatchPatternBindingV9 } from "@shared/types/dispatchV9.js";
import { assertProtectedConfigIntegrity } from "@services/safety/configIntegrity.js";
import {
  DISPATCH_PATTERN_BINDINGS,
  getDispatchPatternIntegrityPayload
} from '@platform/runtime/dispatchPatternPayload.js';

export {
  DISPATCH_PATTERN_BINDINGS,
  DISPATCH_V9_EXEMPT_ROUTES
} from '@platform/runtime/dispatchPatternPayload.js';

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

assertProtectedConfigIntegrity(
  'dispatch_patterns',
  getDispatchPatternIntegrityPayload(),
  {
    source: 'src/platform/runtime/dispatchPatterns.ts'
  }
);
