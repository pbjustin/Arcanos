export interface ModuleCatalogEntry {
  readonly source: `./${string}.js`;
  readonly route: string;
  readonly name: string;
  readonly diagnosticsKey: string;
  readonly gptIds?: readonly string[];
  readonly gptAccessOnly?: true;
}

export interface ModuleExposurePolicy {
  readonly gptAccessOnly?: boolean;
  readonly exposeLegacyRoute?: boolean;
}

const MODULE_SOURCE_PATTERN = /^\.\/[a-z0-9]+(?:-[a-z0-9]+)*\.js$/;
const MODULE_ROUTE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODULE_NAME_PATTERN = /^[A-Z0-9]+(?::[A-Z0-9_]+)*$/;
const MODULE_DIAGNOSTICS_KEY_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*$/;

/**
 * Owns and validates the executable module inventory.
 *
 * Catalog entries are copied and frozen so runtime discovery cannot be changed
 * by generated files, directory order, or caller mutation.
 */
export function defineModuleCatalog(
  entries: readonly ModuleCatalogEntry[]
): readonly ModuleCatalogEntry[] {
  if (entries.length === 0) {
    throw new Error('Module catalog must contain at least one entry.');
  }

  const sources = new Set<string>();
  const routes = new Set<string>();
  const names = new Set<string>();
  const diagnosticsKeys = new Set<string>();
  const gptIds = new Set<string>();
  const catalogRoutes = new Set(entries.map(({ route }) => route));

  for (const entry of entries) {
    if (!MODULE_SOURCE_PATTERN.test(entry.source)) {
      throw new Error(`Invalid module catalog source: ${entry.source}`);
    }
    if (!MODULE_ROUTE_PATTERN.test(entry.route)) {
      throw new Error(`Invalid module catalog route: ${entry.route}`);
    }
    if (!MODULE_NAME_PATTERN.test(entry.name)) {
      throw new Error(`Invalid module catalog name: ${entry.name}`);
    }
    if (!MODULE_DIAGNOSTICS_KEY_PATTERN.test(entry.diagnosticsKey)) {
      throw new Error(
        `Invalid module catalog diagnostics key: ${entry.diagnosticsKey}`
      );
    }
    if (
      entry.gptAccessOnly !== undefined
      && entry.gptAccessOnly !== true
    ) {
      throw new Error(`Invalid module catalog exposure: ${entry.name}`);
    }
    if (
      entry.gptIds !== undefined
      && (
        entry.gptAccessOnly === true
        || entry.gptIds.length === 0
        || entry.gptIds.some(gptId => !MODULE_ROUTE_PATTERN.test(gptId))
      )
    ) {
      throw new Error(`Invalid module catalog GPT IDs: ${entry.name}`);
    }
    if (sources.has(entry.source)) {
      throw new Error(`Duplicate module catalog source: ${entry.source}`);
    }
    if (routes.has(entry.route)) {
      throw new Error(`Duplicate module catalog route: ${entry.route}`);
    }
    if (names.has(entry.name)) {
      throw new Error(`Duplicate module catalog name: ${entry.name}`);
    }
    if (diagnosticsKeys.has(entry.diagnosticsKey)) {
      throw new Error(
        `Duplicate module catalog diagnostics key: ${entry.diagnosticsKey}`
      );
    }

    sources.add(entry.source);
    routes.add(entry.route);
    names.add(entry.name);
    diagnosticsKeys.add(entry.diagnosticsKey);
    for (const gptId of entry.gptIds ?? []) {
      if (
        gptIds.has(gptId)
        || (gptId !== entry.route && catalogRoutes.has(gptId))
      ) {
        throw new Error(`Duplicate module catalog GPT ID: ${gptId}`);
      }
      gptIds.add(gptId);
    }
  }

  return Object.freeze(
    entries.map((entry) => Object.freeze({
      ...entry,
      ...(entry.gptIds
        ? { gptIds: Object.freeze([...entry.gptIds]) }
        : {})
    }))
  );
}

export const MODULE_CATALOG = defineModuleCatalog([
  {
    source: './arcanos-audit.js',
    route: 'audit',
    name: 'ARCANOS:AUDIT',
    diagnosticsKey: 'AUDIT',
    gptIds: ['arcanos-audit', 'audit']
  },
  {
    source: './arcanos-build.js',
    route: 'build',
    name: 'ARCANOS:BUILD',
    diagnosticsKey: 'BUILD',
    gptIds: ['arcanos-build', 'build']
  },
  {
    source: './arcanos-cli.js',
    route: 'cli',
    name: 'ARCANOS:CLI',
    diagnosticsKey: 'CLI',
    gptAccessOnly: true
  },
  {
    source: './arcanos-core.js',
    route: 'core',
    name: 'ARCANOS:CORE',
    diagnosticsKey: 'CORE',
    gptIds: ['arcanos-core', 'core', 'arcanos-daemon']
  },
  {
    source: './arcanos-gaming.js',
    route: 'gaming',
    name: 'ARCANOS:GAMING',
    diagnosticsKey: 'GAMING',
    gptIds: ['arcanos-gaming', 'gaming']
  },
  {
    source: './arcanos-guide.js',
    route: 'guide',
    name: 'ARCANOS:GUIDE',
    diagnosticsKey: 'GUIDE',
    gptIds: ['arcanos-guide', 'guide']
  },
  {
    source: './arcanos-local-agent.js',
    route: 'local-agent',
    name: 'ARCANOS:LOCAL_AGENT',
    diagnosticsKey: 'LOCAL_AGENT',
    gptAccessOnly: true
  },
  {
    source: './arcanos-productivity.js',
    route: 'productivity',
    name: 'ARCANOS:PRODUCTIVITY',
    diagnosticsKey: 'PRODUCTIVITY',
    gptAccessOnly: true
  },
  {
    source: './arcanos-research.js',
    route: 'research',
    name: 'ARCANOS:RESEARCH',
    diagnosticsKey: 'RESEARCH',
    gptIds: ['arcanos-research', 'research']
  },
  {
    source: './arcanos-sim.js',
    route: 'sim',
    name: 'ARCANOS:SIM',
    diagnosticsKey: 'SIM',
    gptIds: ['arcanos-sim', 'sim']
  },
  {
    source: './arcanos-tracker.js',
    route: 'tracker',
    name: 'ARCANOS:TRACKER',
    diagnosticsKey: 'TRACKER',
    gptIds: ['arcanos-tracker', 'tracker']
  },
  {
    source: './arcanos-tutor.js',
    route: 'tutor',
    name: 'ARCANOS:TUTOR',
    diagnosticsKey: 'TUTOR',
    gptIds: ['arcanos-tutor', 'tutor']
  },
  {
    source: './arcanos-write.js',
    route: 'write',
    name: 'ARCANOS:WRITE',
    diagnosticsKey: 'WRITE',
    gptIds: ['arcanos-write', 'write']
  },
  {
    source: './backstage-booker.js',
    route: 'backstage-booker',
    name: 'BACKSTAGE:BOOKER',
    diagnosticsKey: 'BOOKING',
    gptIds: ['backstage-booker', 'backstage']
  },
  {
    source: './hrc.js',
    route: 'hrc',
    name: 'HRC',
    diagnosticsKey: 'HRC',
    gptIds: ['hrc']
  }
] as const);

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function slugIdentifier(value: string): string {
  return normalizeIdentifier(value)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const protectedModuleIdentifiers = new Set(
  MODULE_CATALOG
    .filter((entry) => entry.gptAccessOnly === true)
    .flatMap((entry) => [
      normalizeIdentifier(entry.route),
      normalizeIdentifier(entry.name),
      slugIdentifier(entry.name),
      entry.source.replace(/^\.\//, '').replace(/\.js$/, '')
    ])
);

export const PROTECTED_MODULE_IDENTIFIERS = Object.freeze(
  [...protectedModuleIdentifiers].sort()
);

/**
 * Prevents protected capability identifiers from falling through to public
 * substring, token, or fuzzy GPT routing.
 */
export function isProtectedModuleIdentifier(value: string): boolean {
  return (
    protectedModuleIdentifiers.has(normalizeIdentifier(value))
    || protectedModuleIdentifiers.has(slugIdentifier(value))
  );
}

export function isPublicGptModule(
  value: ModuleExposurePolicy
): boolean {
  return value.gptAccessOnly !== true;
}

export function isLegacyModuleExposed(
  value: ModuleExposurePolicy
): boolean {
  return isPublicGptModule(value) && value.exposeLegacyRoute !== false;
}
