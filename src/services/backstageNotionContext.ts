import {
  createAbortError,
  getRequestAbortSignal,
  runWithRequestAbortTimeout,
} from '@arcanos/runtime';
import { BACKSTAGE_UNIVERSE_ID_PATTERN } from '@core/db/repositories/backstageBookerRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';
import { getEnv } from '@platform/runtime/env.js';
import { timingSafeEqualOpaqueSecret } from '@shared/security/opaqueSecret.js';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '@shared/security/purposeBoundCredential.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  markBackstageNotionEnrichmentUsed,
} from './backstageNotionEnrichmentAuthorization.js';

export const BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_ACCESS_TOKEN';
export const BACKSTAGE_NOTION_UNIVERSE_PAGES_ENV_NAME =
  'ARCANOS_BACKSTAGE_NOTION_UNIVERSE_PAGES_JSON';
export const BACKSTAGE_NOTION_API_VERSION = '2026-03-11';
export const BACKSTAGE_NOTION_FETCH_TIMEOUT_MS = 4_000;
export const BACKSTAGE_NOTION_MAX_RESPONSE_BYTES = 256 * 1024;
export const BACKSTAGE_NOTION_MAX_PAGES_PER_UNIVERSE = 3;
export const BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS = 4_000;
export const BACKSTAGE_NOTION_TOTAL_CONTEXT_CODE_POINTS =
  BACKSTAGE_NOTION_MAX_PAGES_PER_UNIVERSE
  * BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS;

const BACKSTAGE_NOTION_SANITIZATION_INPUT_CODE_POINTS =
  BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS * 2;

const BACKSTAGE_NOTION_MAX_CONFIG_BYTES = 16 * 1024;
const BACKSTAGE_NOTION_MAX_CONFIGURED_UNIVERSES = 32;
const BACKSTAGE_NOTION_MAX_TOKEN_LENGTH = 4_096;
const NOTION_PAGE_ID_PATTERN = /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu;
const NOTION_VISIBLE_TOKEN_PATTERN = /^[\x21-\x7E]+$/u;
const NOTION_API_ORIGIN = 'https://api.notion.com';

type FetchImplementation = typeof fetch;
type EnvironmentReader = (name: string) => string | undefined;

export interface BackstageNotionPromptContext {
  content: string;
  pageCount: number;
  truncated: boolean;
  codePoints: number;
}

export interface BackstageNotionContextDependencies {
  fetchImpl?: FetchImplementation;
  readEnvironment?: EnvironmentReader;
  timeoutMs?: number;
}

interface BackstageNotionConfiguration {
  accessToken: string;
  pagesByUniverse: Map<string, readonly string[]>;
}

interface NotionMarkdownResponse {
  markdown: string;
  truncated: boolean;
  unknownBlockCount: number;
}

class BackstageNotionReadError extends Error {
  readonly category: string;

  constructor(category: string) {
    super('Backstage Notion reference is unavailable.');
    this.name = 'BackstageNotionReadError';
    this.category = category;
  }
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

function isPlainConfigurationObject(
  value: unknown
): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function parseUniversePageMapping(rawValue: string): Map<string, readonly string[]> | null {
  if (Buffer.byteLength(rawValue, 'utf8') > BACKSTAGE_NOTION_MAX_CONFIG_BYTES) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }

  if (!isPlainConfigurationObject(parsed)) {
    return null;
  }

  const entries = Object.entries(parsed);
  if (entries.length > BACKSTAGE_NOTION_MAX_CONFIGURED_UNIVERSES) {
    return null;
  }

  const mapping = new Map<string, readonly string[]>();
  for (const [universeId, rawPageIds] of entries) {
    if (
      universeId !== universeId.trim()
      || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
      || universeId === '__proto__'
      || universeId === 'constructor'
      || universeId === 'prototype'
      || !Array.isArray(rawPageIds)
      || rawPageIds.length < 1
      || rawPageIds.length > BACKSTAGE_NOTION_MAX_PAGES_PER_UNIVERSE
    ) {
      return null;
    }

    const pageIds: string[] = [];
    const seenPageIds = new Set<string>();
    for (const rawPageId of rawPageIds) {
      if (typeof rawPageId !== 'string' || rawPageId !== rawPageId.trim()) {
        return null;
      }
      const pageId = normalizeNotionPageId(rawPageId);
      if (!pageId || seenPageIds.has(pageId)) {
        return null;
      }
      seenPageIds.add(pageId);
      pageIds.push(pageId);
    }

    mapping.set(universeId, Object.freeze(pageIds));
  }

  return mapping;
}

function readBackstageNotionConfiguration(
  readEnvironment: EnvironmentReader
): BackstageNotionConfiguration | null {
  const rawToken = readEnvironment(BACKSTAGE_NOTION_ACCESS_TOKEN_ENV_NAME);
  const rawMapping = readEnvironment(BACKSTAGE_NOTION_UNIVERSE_PAGES_ENV_NAME);
  if (rawToken === undefined && rawMapping === undefined) {
    return null;
  }
  if (rawToken === undefined || rawMapping === undefined) {
    logNotionWarning('backstage.notion_context.configuration_invalid', {
      reason: 'partial_configuration',
    });
    return null;
  }

  if (
    rawToken !== rawToken.trim()
    || rawToken.length < 16
    || rawToken.length > BACKSTAGE_NOTION_MAX_TOKEN_LENGTH
    || !NOTION_VISIBLE_TOKEN_PATTERN.test(rawToken)
    || /^(?:replace|example|placeholder|changeme)(?:[-_]|$)/iu.test(rawToken)
    || PURPOSE_BOUND_CREDENTIAL_ENV_NAMES.some((environmentName) => {
      const applicationCredential = readEnvironment(environmentName)?.trim();
      return Boolean(
        applicationCredential
        && timingSafeEqualOpaqueSecret(rawToken, applicationCredential)
      );
    })
  ) {
    logNotionWarning('backstage.notion_context.configuration_invalid', {
      reason: 'invalid_access_token',
    });
    return null;
  }

  const pagesByUniverse = parseUniversePageMapping(rawMapping);
  if (!pagesByUniverse) {
    logNotionWarning('backstage.notion_context.configuration_invalid', {
      reason: 'invalid_universe_page_mapping',
    });
    return null;
  }

  return {
    accessToken: rawToken,
    pagesByUniverse,
  };
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = /^\d+$/u.test(declaredLength)
      ? Number.parseInt(declaredLength, 10)
      : Number.NaN;
    if (
      !Number.isFinite(parsedLength)
      || parsedLength < 0
      || parsedLength > BACKSTAGE_NOTION_MAX_RESPONSE_BYTES
    ) {
      await response.body?.cancel().catch(() => undefined);
      throw new BackstageNotionReadError('response_too_large');
    }
  }

  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > BACKSTAGE_NOTION_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new BackstageNotionReadError('response_too_large');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new BackstageNotionReadError('invalid_utf8');
  }
}

function parseNotionMarkdownResponse(
  rawBody: string,
  expectedPageId: string
): NotionMarkdownResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody) as unknown;
  } catch {
    throw new BackstageNotionReadError('invalid_json');
  }

  if (!isPlainConfigurationObject(parsed)) {
    throw new BackstageNotionReadError('invalid_response');
  }

  const responsePageId = typeof parsed.id === 'string'
    ? normalizeNotionPageId(parsed.id)
    : null;
  const unknownBlockIds = parsed.unknown_block_ids;
  if (
    parsed.object !== 'page_markdown'
    || responsePageId !== expectedPageId
    || typeof parsed.markdown !== 'string'
    || typeof parsed.truncated !== 'boolean'
    || !Array.isArray(unknownBlockIds)
    || unknownBlockIds.length > 100
    || unknownBlockIds.some(value => (
      typeof value !== 'string' || normalizeNotionPageId(value) === null
    ))
  ) {
    throw new BackstageNotionReadError('invalid_response');
  }

  return {
    markdown: parsed.markdown,
    truncated: parsed.truncated,
    unknownBlockCount: unknownBlockIds.length,
  };
}

async function fetchNotionMarkdownPage(
  fetchImpl: FetchImplementation,
  accessToken: string,
  pageId: string,
  signal: AbortSignal
): Promise<NotionMarkdownResponse> {
  const endpoint = new URL(
    `/v1/pages/${pageId}/markdown`,
    NOTION_API_ORIGIN
  );
  endpoint.searchParams.set('include_transcript', 'false');
  const response = await fetchImpl(endpoint, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'Notion-Version': BACKSTAGE_NOTION_API_VERSION,
    },
    redirect: 'manual',
    signal,
  });

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new BackstageNotionReadError(
      response.status >= 300 && response.status < 400
        ? 'redirect_rejected'
        : `http_${response.status}`
    );
  }

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    await response.body?.cancel().catch(() => undefined);
    throw new BackstageNotionReadError('invalid_content_type');
  }

  return parseNotionMarkdownResponse(
    await readBoundedResponseBody(response),
    pageId
  );
}

function truncateCodePoints(
  value: string,
  maximum: number
): { value: string; truncated: boolean; codePoints: number } {
  let codePoints = 0;
  let endIndex = 0;
  for (const character of value) {
    if (codePoints >= maximum) {
      return {
        value: value.slice(0, endIndex),
        truncated: true,
        codePoints,
      };
    }
    codePoints += 1;
    endIndex += character.length;
  }

  return { value, truncated: false, codePoints };
}

function sanitizeNotionMarkdown(value: string): string {
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[\u0085\u2028\u2029]/gu, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu, '\uFFFD')
    .replace(/[\u061C\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/gu, '\uFFFD')
    .replaceAll('<<', '‹‹')
    .replaceAll('>>', '››')
    .replace(
      /<(\/)?(?:page|database)\b[^>\r\n]*>/giu,
      (_tag, closing: string | undefined) => closing ? ']' : '[Linked Notion item: '
    )
    .replace(
      /<(\/)?(?:file|image|video|audio|pdf)\b[^>\r\n]*>/giu,
      (_tag, closing: string | undefined) => closing ? ']' : '[Media omitted: '
    )
    .replace(/<unknown\b[^>\r\n]*\/?\s*>/giu, '[Unavailable Notion block omitted]')
    .replace(/(?:https?|notion):\/\/[^\s)<>'"]+/giu, '[link omitted]');
}

function quoteNotionMarkdown(value: string): string {
  return value
    .split('\n')
    .map(line => `> ${line}`)
    .join('\n');
}

function readFailureCategory(reason: unknown): string {
  return reason instanceof BackstageNotionReadError
    ? reason.category
    : reason instanceof Error && reason.name === 'AbortError'
      ? 'timeout'
      : 'request_failed';
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
  if (
    !isBackstageNotionEnrichmentAuthorized()
    || universeId !== universeId.trim()
    || !BACKSTAGE_UNIVERSE_ID_PATTERN.test(universeId)
  ) {
    return null;
  }

  const readEnvironment = dependencies.readEnvironment ?? (name => getEnv(name));
  const parentSignal = getRequestAbortSignal();
  const startedAt = Date.now();
  let configuration: BackstageNotionConfiguration | null;
  try {
    configuration = readBackstageNotionConfiguration(readEnvironment);
  } catch {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createAbortError();
    }
    logNotionWarning('backstage.notion_context.unavailable', {
      category: 'configuration_read_failed',
      requestedPages: 0,
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
  if (!configuration) {
    return null;
  }

  const pageIds = configuration.pagesByUniverse.get(universeId);
  if (!pageIds) {
    return null;
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const requestedTimeoutMs = dependencies.timeoutMs
    ?? BACKSTAGE_NOTION_FETCH_TIMEOUT_MS;
  const timeoutMs = Number.isFinite(requestedTimeoutMs)
    ? Math.max(
        1,
        Math.min(
          BACKSTAGE_NOTION_FETCH_TIMEOUT_MS,
          Math.trunc(requestedTimeoutMs)
        )
      )
    : BACKSTAGE_NOTION_FETCH_TIMEOUT_MS;
  try {
    const pageResults = await runWithRequestAbortTimeout(
      {
        timeoutMs,
        parentSignal,
        abortMessage: 'Backstage Notion reference retrieval timed out.',
      },
      async () => {
        const signal = getRequestAbortSignal();
        if (!signal) {
          throw new BackstageNotionReadError('missing_abort_signal');
        }
        return Promise.allSettled(
          pageIds.map(pageId => fetchNotionMarkdownPage(
            fetchImpl,
            configuration.accessToken,
            pageId,
            signal
          ))
        );
      }
    );

    let promptContent = '';
    let loadedPageCount = 0;
    const failureCategories: string[] = [];
    let truncated = false;
    let totalCodePoints = 0;

    for (const [index, result] of pageResults.entries()) {
      if (result.status === 'rejected') {
        failureCategories.push(readFailureCategory(result.reason));
        continue;
      }

      const sanitizationInput = truncateCodePoints(
        result.value.markdown,
        BACKSTAGE_NOTION_SANITIZATION_INPUT_CODE_POINTS
      );
      const sanitized = sanitizeNotionMarkdown(sanitizationInput.value);
      if (sanitized.trim().length === 0) {
        continue;
      }
      const projectedMarkdown = truncateCodePoints(
        sanitized,
        BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS
      );
      let pageTruncated = sanitizationInput.truncated
        || projectedMarkdown.truncated
        || result.value.truncated
        || result.value.unknownBlockCount > 0;
      const buildPageSection = () => [
        `[Configured Notion reference ${index + 1}${pageTruncated ? ' — partial' : ''}]`,
        quoteNotionMarkdown(projectedMarkdown.value),
      ].join('\n');
      let projectedSection = truncateCodePoints(
        buildPageSection(),
        BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS
      );
      if (projectedSection.truncated && !pageTruncated) {
        pageTruncated = true;
        projectedSection = truncateCodePoints(
          buildPageSection(),
          BACKSTAGE_NOTION_PAGE_CONTEXT_CODE_POINTS
        );
      }

      const separator = promptContent.length > 0 ? '\n\n' : '';
      const remainingCodePoints = BACKSTAGE_NOTION_TOTAL_CONTEXT_CODE_POINTS
        - totalCodePoints
        - Array.from(separator).length;
      if (remainingCodePoints <= 0) {
        truncated = true;
        break;
      }
      let finalSection = truncateCodePoints(
        projectedSection.value,
        remainingCodePoints
      );
      if (finalSection.truncated && !pageTruncated) {
        pageTruncated = true;
        finalSection = truncateCodePoints(
          buildPageSection(),
          remainingCodePoints
        );
      }

      promptContent += separator + finalSection.value;
      totalCodePoints += Array.from(separator).length + finalSection.codePoints;
      loadedPageCount += 1;
      truncated ||= pageTruncated
        || projectedSection.truncated
        || finalSection.truncated;
    }

    if (failureCategories.length > 0) {
      logNotionWarning('backstage.notion_context.partially_unavailable', {
        requestedPages: pageIds.length,
        loadedPages: loadedPageCount,
        failureCategories,
        durationMs: Date.now() - startedAt,
      });
    }
    if (loadedPageCount === 0) {
      return null;
    }

    logNotionInfo('backstage.notion_context.loaded', {
      requestedPages: pageIds.length,
      loadedPages: loadedPageCount,
      codePoints: totalCodePoints,
      truncated,
      durationMs: Date.now() - startedAt,
    });
    markBackstageNotionEnrichmentUsed();
    return {
      content: promptContent,
      pageCount: loadedPageCount,
      truncated,
      codePoints: totalCodePoints,
    };
  } catch (error) {
    if (parentSignal?.aborted) {
      throw parentSignal.reason instanceof Error
        ? parentSignal.reason
        : createAbortError();
    }
    logNotionWarning('backstage.notion_context.unavailable', {
      category: readFailureCategory(error),
      requestedPages: pageIds.length,
      durationMs: Date.now() - startedAt,
    });
    return null;
  }
}
