// Utility to decide how a prompt should be handled
// Returns one of: 'write', 'audit', 'codegen', or 'sim'

export type IntentMode = 'write' | 'audit' | 'codegen' | 'sim';

/**
 * Basic keyword routing for prompts.
 * - codegen: references to code, GitHub Actions, or languages
 * - audit: mentions analysis or CLEAR framework
 * - sim: asks for simulations or hypothetical behavior
 * - write: default catch-all
 */
export function routeByIntent(prompt: string): IntentMode {
  const text = prompt.toLowerCase();

  // Code generation or devops related keywords
  if (/\b(code|github actions?|javascript|typescript|python|programming|algorithm)\b/.test(text)) {
    return 'codegen';
  }

  // Audit style requests
  if (/(analyze|audit|evaluate|c\.l\.e\.a\.r)/.test(text)) {
    return 'audit';
  }

  // Simulation or hypothetical scenarios
  if (/(simulate|simulation|hypothetical|what if|agent actions?|agent behaviour|agent behavior)/.test(text)) {
    return 'sim';
  }

  return 'write';
}
