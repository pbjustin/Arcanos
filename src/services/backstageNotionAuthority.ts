import { getEnv } from '@platform/runtime/env.js';
import {
  getBackstageNotionRagRepository,
  type BackstageNotionRagRepository,
} from '@core/db/repositories/backstageNotionRagRepository.js';
import {
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
  parseBackstageNotionAuthorityConfiguration,
  resolveBackstageNotionAuthorityRoot as resolveConfiguredAuthorityRoot,
  type BackstageNotionAuthorityConfiguration,
  type BackstageNotionAuthorityRoot,
} from '@shared/backstage/backstageNotionAuthorityCore.js';
import { BackstageNotionAuthorityUnavailableError } from './backstageBookerContracts.js';

export {
  BACKSTAGE_NOTION_AUTHORITY_MAX_CONFIG_BYTES,
  BACKSTAGE_NOTION_AUTHORITY_MAX_INITIAL_PAGE_COUNT,
  BACKSTAGE_NOTION_AUTHORITY_MAX_ROOTS,
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
} from '@shared/backstage/backstageNotionAuthorityCore.js';
export type {
  BackstageNotionAuthorityConfiguration,
  BackstageNotionAuthorityConfigurationInvalidReason,
  BackstageNotionAuthorityRoot,
} from '@shared/backstage/backstageNotionAuthorityCore.js';

export type BackstageNotionAuthorityEnvironmentReader = (
  name: string
) => string | undefined;

export interface BackstageNotionAuthorityDependencies {
  readEnvironment?: BackstageNotionAuthorityEnvironmentReader;
  repository?: Pick<BackstageNotionRagRepository, 'loadAuthorityHead'>;
}

export const BACKSTAGE_NOTION_AUTHORITY_DATABASE_SQLSTATE = 'BN001';

/** Recognize the database's one-way authority fence through bounded causes. */
export function isBackstageNotionAuthorityDatabaseError(value: unknown): boolean {
  const pending: unknown[] = [value];
  const seen = new Set<object>();
  for (let inspected = 0; pending.length > 0 && inspected < 8; inspected += 1) {
    const current = pending.shift();
    if (typeof current !== 'object' || current === null || seen.has(current)) {
      continue;
    }
    seen.add(current);
    try {
      const candidate = current as {
        cause?: unknown;
        code?: unknown;
        errors?: unknown;
        rollbackCause?: unknown;
      };
      if (candidate.code === BACKSTAGE_NOTION_AUTHORITY_DATABASE_SQLSTATE) {
        return true;
      }
      if (candidate.cause !== undefined) pending.push(candidate.cause);
      if (candidate.rollbackCause !== undefined) pending.push(candidate.rollbackCause);
      if (Array.isArray(candidate.errors)) pending.push(...candidate.errors.slice(0, 8));
    } catch {
      // Hostile accessors cannot widen the authority boundary.
    }
  }
  return false;
}

/** Read and validate the complete Notion-authority configuration. */
export function readBackstageNotionAuthorityConfiguration(
  dependencies: BackstageNotionAuthorityDependencies = {}
): BackstageNotionAuthorityConfiguration {
  const readEnvironment = dependencies.readEnvironment
    ?? ((name: string) => getEnv(name));

  try {
    return parseBackstageNotionAuthorityConfiguration(
      readEnvironment(BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME)
    );
  } catch {
    return Object.freeze({
      status: 'invalid' as const,
      roots: Object.freeze([]) as readonly [],
      reason: 'environment_read_failed' as const,
    });
  }
}

/** Resolve a Notion-authoritative universe by exact identifier. */
export function resolveBackstageNotionAuthorityRoot(
  universeId: string,
  dependencies: BackstageNotionAuthorityDependencies = {}
): BackstageNotionAuthorityRoot | null {
  return resolveConfiguredAuthorityRoot(
    readBackstageNotionAuthorityConfiguration(dependencies),
    universeId
  );
}

/** Return whether backend canon writes must be denied for this universe. */
export function isBackstageNotionAuthoritativeUniverse(
  universeId: string,
  dependencies: BackstageNotionAuthorityDependencies = {}
): boolean {
  const configuration = readBackstageNotionAuthorityConfiguration(dependencies);
  // A present but malformed authority boundary must fail closed for mutations.
  // The exact universe cannot be resolved for generation or synchronization,
  // but permitting writes would undermine the operator's declared authority.
  return configuration.status === 'invalid'
    || resolveConfiguredAuthorityRoot(configuration, universeId) !== null;
}

/**
 * Resolve the effective one-way authority latch from configuration and the
 * durable PostgreSQL head. Configuration may opt a universe in before its
 * first snapshot, but it can never opt a persisted Notion authority back out.
 */
export async function resolveEffectiveBackstageNotionAuthorityRoot(
  universeId: string,
  dependencies: BackstageNotionAuthorityDependencies = {}
): Promise<BackstageNotionAuthorityRoot | null> {
  const configuration = readBackstageNotionAuthorityConfiguration(dependencies);
  if (configuration.status === 'invalid') {
    throw new BackstageNotionAuthorityUnavailableError(universeId);
  }
  const configuredRoot = resolveConfiguredAuthorityRoot(configuration, universeId);

  let head;
  try {
    const repository = dependencies.repository ?? getBackstageNotionRagRepository();
    head = await repository.loadAuthorityHead(universeId);
  } catch (error) {
    // A valid exact mapping is independently sufficient to keep legacy paths
    // closed. Without it, an unavailable durable latch is an unknown authority
    // state and must never be interpreted as PostgreSQL authority.
    if (configuredRoot) {
      return configuredRoot;
    }
    throw new BackstageNotionAuthorityUnavailableError(universeId, error);
  }

  if (head?.authority === 'notion') {
    if (!head.rootPageId) {
      throw new BackstageNotionAuthorityUnavailableError(universeId);
    }
    if (configuredRoot && configuredRoot.rootPageId !== head.rootPageId) {
      throw new BackstageNotionAuthorityUnavailableError(universeId);
    }
    return configuredRoot ?? Object.freeze({
      universeId,
      rootPageId: head.rootPageId,
      displayName: universeId,
    });
  }

  return configuredRoot;
}

/** Return true only after resolving both configured and persistent authority. */
export async function isBackstageNotionAuthorityEnforced(
  universeId: string,
  dependencies: BackstageNotionAuthorityDependencies = {}
): Promise<boolean> {
  return (await resolveEffectiveBackstageNotionAuthorityRoot(
    universeId,
    dependencies
  )) !== null;
}
