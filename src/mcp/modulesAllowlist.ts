/**
 * Hardening for modules.invoke:
 * Allowlist is explicit and deny-by-default.
 *
 * Format (CSV):
 *   MCP_ALLOW_MODULE_ACTIONS="rag:*,billing:charge,ARCANOS:CORE:query"
 *
 * Whitespace is ignored. Use * wildcard for action only (module:*). The final
 * colon separates module from action, so module names may contain colons.
 */
function parseAllowlist(raw: string | undefined): Array<{ module: string; action: string }> {
  if (!raw) return [];
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .map(pair => {
      const separatorIndex = pair.lastIndexOf(':');
      if (separatorIndex <= 0 || separatorIndex >= pair.length - 1) {
        return { module: '', action: '' };
      }

      return {
        module: pair.slice(0, separatorIndex).trim(),
        action: pair.slice(separatorIndex + 1).trim()
      };
    })
    .filter(x => x.module.length > 0 && x.action.length > 0);
}

let cachedRawAllowlist: string | undefined;
let cachedAllowlist: Array<{ module: string; action: string }> = [];

function getModuleActionAllowlist(): Array<{ module: string; action: string }> {
  const rawAllowlist = process.env.MCP_ALLOW_MODULE_ACTIONS;
  if (rawAllowlist !== cachedRawAllowlist) {
    cachedRawAllowlist = rawAllowlist;
    cachedAllowlist = parseAllowlist(rawAllowlist);
  }

  return cachedAllowlist;
}

export function isModuleActionAllowed(moduleName: string, action: string): boolean {
  const allow = getModuleActionAllowlist();
  if (allow.length === 0) return false;

  for (const rule of allow) {
    if (rule.module !== moduleName) continue;
    if (rule.action === '*') return true;
    if (rule.action === action) return true;
  }
  return false;
}
