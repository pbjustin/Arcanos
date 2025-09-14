interface GptModuleEntry {
  route: string;
  module: string;
}

/**
 * Builds a mapping of GPT IDs to module routes and names.
 *
 * Uses the `GPT_MODULE_MAP` environment variable when available. The variable
 * should contain a JSON object where each key is a GPT ID and the value is an
 * object with `route` and `module` properties. Example:
 *
 * ```bash
 * GPT_MODULE_MAP='{"gpt-1":{"route":"tutor","module":"ARCANOS:TUTOR"}}'
 * ```
 *
 * For backwards compatibility, legacy `GPTID_*` environment variables are also
 * supported. These mappings can be removed once all deployments adopt the new
 * configuration format.
 */
export function loadGptModuleMap(): Record<string, GptModuleEntry> {
  const map: Record<string, GptModuleEntry> = {};

  const raw = process.env.GPT_MODULE_MAP;
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Record<string, GptModuleEntry>;
      for (const [gptId, entry] of Object.entries(parsed)) {
        if (entry.route && entry.module) {
          map[gptId] = entry;
        }
      }
    } catch (err) {
      console.warn('Failed to parse GPT_MODULE_MAP', err);
    }
  }

  // Legacy environment variables (to be deprecated)
  const legacyEntries: Array<[string | undefined, GptModuleEntry]> = [
    [process.env.GPTID_BACKSTAGE_BOOKER, { route: 'backstage-booker', module: 'BACKSTAGE:BOOKER' }],
    [process.env.GPTID_ARCANOS_GAMING, { route: 'gaming', module: 'ARCANOS:GAMING' }],
    [process.env.GPTID_ARCANOS_TUTOR, { route: 'tutor', module: 'ARCANOS:TUTOR' }],
  ];

  for (const [id, entry] of legacyEntries) {
    if (id) {
      map[id] = entry;
    }
  }

  return map;
}

const gptModuleMap = loadGptModuleMap();

export default gptModuleMap;
