/**
 * Hardening for modules.invoke:
 * Allowlist is explicit and deny-by-default.
 *
 * Format (CSV):
 *   MCP_ALLOW_MODULE_ACTIONS="rag:*,billing:charge,plans:preview"
 *
 * Whitespace is ignored. Use * wildcard for action only (module:*).
 */
function parseAllowlist(raw: string | undefined): Array<{ module: string; action: string }> {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const [mod, act] = pair.split(':').map(x => (x ?? '').trim());
      return { module: mod, action: act };
    })
    .filter(x => x.module.length > 0 && x.action.length > 0);
}

const allow = parseAllowlist(process.env.MCP_ALLOW_MODULE_ACTIONS);

export function isModuleActionAllowed(moduleName: string, action: string): boolean {
  if (allow.length === 0) return false;

  for (const rule of allow) {
    if (rule.module !== moduleName) continue;
    if (rule.action === '*') return true;
    if (rule.action === action) return true;
  }
  return false;
}
