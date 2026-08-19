export const BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_AUTHORITY_ROOTS_JSON';

export const BACKSTAGE_NOTION_AUTHORITY_MAX_ROOTS = 32;
export const BACKSTAGE_NOTION_AUTHORITY_MAX_CONFIG_BYTES = 32 * 1024;
export const BACKSTAGE_NOTION_AUTHORITY_MAX_INITIAL_PAGE_COUNT = 512;

const BACKSTAGE_UNIVERSE_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const NOTION_PAGE_ID_PATTERN =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const FORBIDDEN_CONFIGURATION_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
]);
const ALLOWED_ROOT_KEYS = new Set([
  'displayName',
  'initialMinimumPageCount',
  'rootPageId',
]);

export interface BackstageNotionAuthorityRoot {
  universeId: string;
  rootPageId: string;
  displayName: string;
  initialMinimumPageCount?: number;
}

export type BackstageNotionAuthorityConfigurationInvalidReason =
  | 'environment_read_failed'
  | 'invalid_json'
  | 'invalid_shape'
  | 'too_large';

export type BackstageNotionAuthorityConfiguration =
  | Readonly<{
      status: 'absent';
      roots: readonly [];
    }>
  | Readonly<{
      status: 'invalid';
      roots: readonly [];
      reason: BackstageNotionAuthorityConfigurationInvalidReason;
    }>
  | Readonly<{
      status: 'valid';
      roots: readonly BackstageNotionAuthorityRoot[];
    }>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeNotionPageId(value: string): string | null {
  if (!NOTION_PAGE_ID_PATTERN.test(value)) {
    return null;
  }

  const compact = value.replaceAll('-', '').toLowerCase();
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

function isValidDisplayName(value: string): boolean {
  const codePointLength = Array.from(value).length;
  return value === value.trim()
    && codePointLength >= 1
    && codePointLength <= 160
    && !/[\u0000-\u001F\u007F-\u009F]/u.test(value)
    && !/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/u.test(value);
}

function invalidConfiguration(
  reason: BackstageNotionAuthorityConfigurationInvalidReason
): BackstageNotionAuthorityConfiguration {
  return Object.freeze({
    status: 'invalid' as const,
    roots: Object.freeze([]) as readonly [],
    reason,
  });
}

/**
 * Parse the complete Notion-authority mapping without reading ambient state.
 * Values are closed objects so misspelled or future fields cannot silently
 * alter the authority boundary.
 */
export function parseBackstageNotionAuthorityConfiguration(
  rawValue: string | undefined
): BackstageNotionAuthorityConfiguration {
  if (rawValue === undefined) {
    return Object.freeze({
      status: 'absent' as const,
      roots: Object.freeze([]) as readonly [],
    });
  }
  if (
    rawValue.length === 0
    || Buffer.byteLength(rawValue, 'utf8')
      > BACKSTAGE_NOTION_AUTHORITY_MAX_CONFIG_BYTES
  ) {
    return invalidConfiguration(
      rawValue.length === 0 ? 'invalid_shape' : 'too_large'
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue) as unknown;
  } catch {
    return invalidConfiguration('invalid_json');
  }
  if (!isPlainObject(parsed)) {
    return invalidConfiguration('invalid_shape');
  }

  const entries = Object.entries(parsed);
  if (
    entries.length < 1
    || entries.length > BACKSTAGE_NOTION_AUTHORITY_MAX_ROOTS
  ) {
    return invalidConfiguration('invalid_shape');
  }

  const roots: BackstageNotionAuthorityRoot[] = [];
  const seenRootPageIds = new Set<string>();
  for (const [universeId, rawRoot] of entries) {
    if (
      universeId !== universeId.trim()
      || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
      || FORBIDDEN_CONFIGURATION_KEYS.has(universeId)
      || !isPlainObject(rawRoot)
    ) {
      return invalidConfiguration('invalid_shape');
    }

    const keys = Object.keys(rawRoot);
    if (
      keys.length < 2
      || keys.length > 3
      || keys.some(key => !ALLOWED_ROOT_KEYS.has(key))
      || !Object.prototype.hasOwnProperty.call(rawRoot, 'rootPageId')
      || !Object.prototype.hasOwnProperty.call(rawRoot, 'displayName')
    ) {
      return invalidConfiguration('invalid_shape');
    }

    const rawRootPageId = rawRoot.rootPageId;
    const rawDisplayName = rawRoot.displayName;
    if (
      typeof rawRootPageId !== 'string'
      || rawRootPageId !== rawRootPageId.trim()
      || typeof rawDisplayName !== 'string'
      || !isValidDisplayName(rawDisplayName)
    ) {
      return invalidConfiguration('invalid_shape');
    }
    const rootPageId = normalizeNotionPageId(rawRootPageId);
    if (!rootPageId || seenRootPageIds.has(rootPageId)) {
      return invalidConfiguration('invalid_shape');
    }

    const rawInitialMinimumPageCount = rawRoot.initialMinimumPageCount;
    if (
      rawInitialMinimumPageCount !== undefined
      && (
        typeof rawInitialMinimumPageCount !== 'number'
        || !Number.isSafeInteger(rawInitialMinimumPageCount)
        || rawInitialMinimumPageCount < 1
        || rawInitialMinimumPageCount
          > BACKSTAGE_NOTION_AUTHORITY_MAX_INITIAL_PAGE_COUNT
      )
    ) {
      return invalidConfiguration('invalid_shape');
    }

    seenRootPageIds.add(rootPageId);
    roots.push(Object.freeze({
      universeId,
      rootPageId,
      displayName: rawDisplayName,
      ...(typeof rawInitialMinimumPageCount !== 'number'
        ? {}
        : { initialMinimumPageCount: rawInitialMinimumPageCount }),
    }));
  }

  return Object.freeze({
    status: 'valid' as const,
    roots: Object.freeze(roots),
  });
}

/** Resolve a configured universe by exact, case-sensitive identifier. */
export function resolveBackstageNotionAuthorityRoot(
  configuration: BackstageNotionAuthorityConfiguration,
  universeId: string
): BackstageNotionAuthorityRoot | null {
  if (
    configuration.status !== 'valid'
    || universeId !== universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
  ) {
    return null;
  }

  return configuration.roots.find(root => root.universeId === universeId)
    ?? null;
}
