import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import {
  BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME,
  BACKSTAGE_NOTION_API_VERSION,
  BACKSTAGE_NOTION_FETCH_TIMEOUT_MS,
  BACKSTAGE_NOTION_MAX_PAGES_PER_UNIVERSE,
  BACKSTAGE_NOTION_MAX_RESPONSE_BYTES,
  BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS,
  BACKSTAGE_NOTION_SYSTEM_POLICY_PROMPT,
  BACKSTAGE_NOTION_TOTAL_CONTEXT_CODE_POINTS,
  BACKSTAGE_NOTION_UNIVERSE_PAGES_ENV_NAME,
  buildBackstageNotionUntrustedContextPrompt,
  loadBackstageNotionPromptContextCore,
  type BackstageNotionEnvironmentReader,
  type BackstageNotionFetchImplementation,
  type BackstageNotionPromptContext,
} from '@shared/backstage/backstageNotionContextCore.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  markBackstageNotionEnrichmentUsed,
} from './backstageNotionEnrichmentAuthorization.js';

export {
  BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME,
  BACKSTAGE_NOTION_API_VERSION,
  BACKSTAGE_NOTION_FETCH_TIMEOUT_MS,
  BACKSTAGE_NOTION_MAX_PAGES_PER_UNIVERSE,
  BACKSTAGE_NOTION_MAX_RESPONSE_BYTES,
  BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS,
  BACKSTAGE_NOTION_SYSTEM_POLICY_PROMPT,
  BACKSTAGE_NOTION_TOTAL_CONTEXT_CODE_POINTS,
  BACKSTAGE_NOTION_UNIVERSE_PAGES_ENV_NAME,
  buildBackstageNotionUntrustedContextPrompt,
};
export type { BackstageNotionPromptContext };

export interface BackstageNotionContextDependencies {
  fetchImpl?: BackstageNotionFetchImplementation;
  readEnvironment?: BackstageNotionEnvironmentReader;
  timeoutMs?: number;
}

function logNotionWarning(
  event: string,
  metadata: Record<string, unknown>
): void {
  try {
    logger.warn(event, metadata);
  } catch {
    // Optional enrichment diagnostics must never fail booking generation.
  }
}

function logNotionInfo(
  event: string,
  metadata: Record<string, unknown>
): void {
  try {
    logger.info(event, metadata);
  } catch {
    // Optional enrichment diagnostics must never fail booking generation.
  }
}

/**
 * Load explicitly configured Notion pages as bounded, untrusted prompt context.
 * Every provider/configuration failure is optional; ambient request aborts are
 * propagated so a disconnected or timed-out request cannot continue to Trinity.
 */
export async function loadBackstageNotionPromptContext(
  universeId: string,
  dependencies: BackstageNotionContextDependencies = {}
): Promise<BackstageNotionPromptContext | null> {
  return loadBackstageNotionPromptContextCore(universeId, {
    authorized: isBackstageNotionEnrichmentAuthorized(),
    fetchImpl: dependencies.fetchImpl ?? fetch,
    readEnvironment: dependencies.readEnvironment ?? (name => getEnv(name)),
    ...(dependencies.timeoutMs === undefined
      ? {}
      : { timeoutMs: dependencies.timeoutMs }),
    logInfo: logNotionInfo,
    logWarning: logNotionWarning,
    markEnrichmentUsed: markBackstageNotionEnrichmentUsed,
  });
}
