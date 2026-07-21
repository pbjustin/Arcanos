import axios from 'axios';
import { load } from 'cheerio';
import { lookup } from 'node:dns/promises';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';
import { getEnv, getEnvIntegerAtLeast } from '@platform/runtime/env.js';

const DEFAULT_MAX_CHARS = 12000;
const LOCALHOST_FETCH_FLAG = 'ARCANOS_ALLOW_LOCALHOST_FETCH';
const DEFAULT_MAX_FETCH_BYTES = 1_500_000;
const DEFAULT_FETCH_TIMEOUT_MS = 8000;
const DEFAULT_MAX_LINKS = 15;
const DEFAULT_USER_AGENT = 'Arcanos-WebFetcher/1.0';
const HARD_MAX_CHARS = 100_000;
const HARD_MAX_FETCH_BYTES = 5_000_000;
const HARD_MAX_FETCH_TIMEOUT_MS = 30_000;
const HARD_MAX_LINKS = 100;
const MAX_EXTRACTION_SELECTORS = 24;
const MAX_EXTRACTION_CANDIDATES = 48;
const MAX_CANDIDATE_SCORE_CHARS = 24000;
const MAX_REPETITION_SEGMENTS = 96;
const MAX_EXTRACTION_METADATA_CHARS = 240;
const MIN_PREFERRED_CONTAINER_SCORE = 0.3;
const NAVIGATION_CONTAINER_SELECTOR = [
  'nav',
  'header',
  'footer',
  'aside',
  '[role="navigation"]',
  '[class*="nav"]',
  '[id*="nav"]',
  '[class*="menu"]',
  '[id*="menu"]',
  '[class*="sidebar"]',
  '[id*="sidebar"]'
].join(', ');
const NAVIGATION_TERMS = new Set([
  'about',
  'account',
  'categories',
  'category',
  'contact',
  'cookie',
  'cookies',
  'home',
  'login',
  'menu',
  'newsletter',
  'popular',
  'previous',
  'privacy',
  'register',
  'related',
  'search',
  'share',
  'signin',
  'subscribe',
  'terms'
]);

type IpFamily = 4 | 6;

interface ResolvedFetchTarget {
  parsedUrl: URL;
  requestUrl: URL;
  hostHeader: string;
  tlsServerName: string;
}

function getConfiguredMaxChars(): number {
  return Math.min(getEnvIntegerAtLeast('WEB_FETCH_MAX_CHARS', DEFAULT_MAX_CHARS, 0), HARD_MAX_CHARS);
}

function getConfiguredFetchTimeoutMs(): number {
  return Math.min(
    getEnvIntegerAtLeast('WEB_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS, 1),
    HARD_MAX_FETCH_TIMEOUT_MS
  );
}

function getConfiguredMaxFetchBytes(): number {
  return Math.min(
    getEnvIntegerAtLeast('WEB_FETCH_MAX_BYTES', DEFAULT_MAX_FETCH_BYTES, 1),
    HARD_MAX_FETCH_BYTES
  );
}

export function getConfiguredWebFetchMaxLinks(): number {
  return Math.min(getEnvIntegerAtLeast('WEB_FETCH_MAX_LINKS', DEFAULT_MAX_LINKS, 0), HARD_MAX_LINKS);
}

function getConfiguredUserAgent(): string {
  return getEnv('WEB_FETCH_USER_AGENT') || DEFAULT_USER_AGENT;
}

export interface FetchAndCleanLinkSummary {
  label: string;
  url: string;
}

export interface FetchAndCleanDocument {
  text: string;
  links: FetchAndCleanLinkSummary[];
  combined: string;
}

export interface FetchAndCleanRawDocument {
  body: string;
  contentType: string;
  truncated: boolean;
}

export interface FetchAndCleanOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  preferredContentSelectors?: readonly string[];
  preferredContentTerms?: readonly string[];
  removeSelectors?: readonly string[];
  includeLinks?: boolean;
  onExtraction?: (metrics: FetchAndCleanExtractionMetrics) => void;
  rawDocumentMaxChars?: number;
  onRawDocument?: (document: FetchAndCleanRawDocument) => void;
}

export interface FetchAndCleanExtractionMetrics {
  strategy: string;
  rawTextLength: number;
  cleanedTextLength: number;
  fetchElapsedMs?: number;
  extractionElapsedMs?: number;
  selectedContainer?: string;
  qualityScore?: number;
  navigationPenalty?: number;
  navigationDensity?: number;
  linkDensity?: number;
  candidateCount?: number;
  documentTitle?: string;
  headingText?: string;
}

function normalizeExtractedText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function tokenizeExtractedText(value: string): string[] {
  return value.toLowerCase().match(/[\p{L}\p{N}+]+/gu) ?? [];
}

function clampUnitMetric(value: number): number {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function roundUnitMetric(value: number): number {
  return Number(clampUnitMetric(value).toFixed(4));
}

function boundExtractionMetadata(value: string): string | undefined {
  const normalized = normalizeExtractedText(value);
  return normalized.length > 0
    ? normalized.slice(0, MAX_EXTRACTION_METADATA_CHARS)
    : undefined;
}

function contentTermOverlap(text: string, terms: readonly string[]): number {
  const textWords = tokenizeExtractedText(text);
  const textTokens = new Set(textWords);
  const boundedTerms = terms
    .slice(0, MAX_EXTRACTION_SELECTORS)
    .map((term) => tokenizeExtractedText(term))
    .filter((termTokens) => termTokens.length > 0);
  if (boundedTerms.length === 0) {
    return 0.5;
  }

  const matchedTerms = boundedTerms.filter((termTokens) =>
    termTokens.every((token) => textTokens.has(token))
  ).length;
  const termTokens = new Set(boundedTerms.flat());
  const matchingWordCount = textWords.reduce(
    (count, word) => count + (termTokens.has(word) ? 1 : 0),
    0
  );
  const termDensity = clampUnitMetric(matchingWordCount * 5 / Math.max(1, textWords.length));
  const termCoverage = matchedTerms / boundedTerms.length;
  return termCoverage * (0.25 + termDensity * 0.75);
}

interface ScoredExtractionCandidate {
  selector: string;
  text: string;
  headingText?: string;
  qualityScore: number;
  termOverlap: number;
  navigationPenalty: number;
  navigationDensity: number;
  linkDensity: number;
}

function scoreExtractionCandidate(
  $: ReturnType<typeof load>,
  element: cheerio.Element,
  selector: string,
  preferredContentTerms: readonly string[]
): ScoredExtractionCandidate {
  const candidate = $(element);
  const fullText = normalizeExtractedText(candidate.text());
  const scoringText = fullText.slice(0, MAX_CANDIDATE_SCORE_CHARS);
  const scoringTextLength = scoringText.length;
  const words = tokenizeExtractedText(scoringText);
  const sentenceCount = scoringText.match(/[.!?。！？]+(?:\s|$)/g)?.length ?? 0;
  const sentenceDensity = clampUnitMetric(sentenceCount / Math.max(1, words.length / 24));

  let paragraphTextLength = 0;
  candidate.find('p').slice(0, MAX_REPETITION_SEGMENTS).each((_, paragraph) => {
    paragraphTextLength += normalizeExtractedText($(paragraph).text())
      .slice(0, MAX_CANDIDATE_SCORE_CHARS).length;
  });
  const paragraphDensity = clampUnitMetric(
    Math.min(scoringTextLength, paragraphTextLength) / Math.max(1, scoringTextLength)
  );

  const markupLength = Math.min(
    MAX_CANDIDATE_SCORE_CHARS,
    Math.max(scoringTextLength, candidate.html()?.length ?? 0)
  );
  const textDensity = clampUnitMetric(scoringTextLength / Math.max(1, markupLength));
  const textLengthScore = clampUnitMetric(scoringTextLength / 600);
  const termOverlap = contentTermOverlap(scoringText, preferredContentTerms);

  const linkTextLength = normalizeExtractedText(candidate.find('a').text())
    .slice(0, MAX_CANDIDATE_SCORE_CHARS).length;
  const linkDensity = clampUnitMetric(
    (candidate.is('a') ? scoringTextLength : Math.min(scoringTextLength, linkTextLength)) /
      Math.max(1, scoringTextLength)
  );

  const semanticNavigationTextLength = candidate.is(NAVIGATION_CONTAINER_SELECTOR)
    ? scoringTextLength
    : normalizeExtractedText(candidate.find(NAVIGATION_CONTAINER_SELECTOR).text())
      .slice(0, MAX_CANDIDATE_SCORE_CHARS).length;
  const semanticNavigationDensity = clampUnitMetric(
    Math.min(scoringTextLength, semanticNavigationTextLength) / Math.max(1, scoringTextLength)
  );
  const navigationTermCount = words.reduce(
    (count, word) => count + (NAVIGATION_TERMS.has(word) ? 1 : 0),
    0
  );
  const navigationTermDensity = clampUnitMetric(navigationTermCount * 4 / Math.max(1, words.length));
  const navigationDensity = Math.max(semanticNavigationDensity, navigationTermDensity);

  const repeatedSegments: string[] = [];
  candidate
    .find('p, li, dt, dd, h1, h2, h3, h4, h5, h6, a')
    .slice(0, MAX_REPETITION_SEGMENTS)
    .each((_, segment) => {
      const segmentText = normalizeExtractedText($(segment).text()).slice(0, 240).toLowerCase();
      if (segmentText.length > 1) {
        repeatedSegments.push(segmentText);
      }
    });
  const segmentCounts = new Map<string, number>();
  for (const segment of repeatedSegments) {
    segmentCounts.set(segment, (segmentCounts.get(segment) ?? 0) + 1);
  }
  const duplicateSegmentCount = Array.from(segmentCounts.values()).reduce(
    (count, occurrences) => count + Math.max(0, occurrences - 1),
    0
  );
  const repetitionPenalty = clampUnitMetric(
    duplicateSegmentCount / Math.max(1, repeatedSegments.length)
  );
  const navigationPenalty = clampUnitMetric(
    linkDensity * 0.45 + navigationDensity * 0.4 + repetitionPenalty * 0.15
  );

  const positiveScore =
    sentenceDensity * 0.24 +
    paragraphDensity * 0.18 +
    textDensity * 0.14 +
    textLengthScore * 0.16 +
    termOverlap * 0.28;
  const qualityScore = clampUnitMetric(positiveScore * (1 - navigationPenalty * 0.65));

  const headings: string[] = [];
  candidate.find('h1, h2, h3').slice(0, 6).each((_, heading) => {
    const headingText = normalizeExtractedText($(heading).text());
    if (headingText.length > 0 && !headings.includes(headingText)) {
      headings.push(headingText);
    }
  });
  const headingText = boundExtractionMetadata(headings.join(' | '));

  return {
    selector: selector.slice(0, MAX_EXTRACTION_METADATA_CHARS),
    text: scoringText,
    ...(headingText ? { headingText } : {}),
    qualityScore,
    termOverlap,
    navigationPenalty,
    navigationDensity,
    linkDensity
  };
}

/**
 * Purpose: Parse and validate a user-provided URL for fetch usage.
 * Inputs/Outputs: raw URL string -> normalized URL object.
 * Edge cases: Rejects blank values, non-http(s) schemes, and credential-bearing URLs.
 */
export function assertHttpUrl(rawUrl: string): URL {
  //audit assumption: an empty URL is always invalid input; failure risk: ambiguous fetch target; expected invariant: non-empty URL string; handling strategy: fail fast with explicit error.
  if (!rawUrl || !rawUrl.trim()) {
    throw new Error('A URL is required for web fetching');
  }

  const parsed = new URL(rawUrl);
  //audit assumption: only network-safe protocols should be allowed; failure risk: local file or custom protocol abuse; expected invariant: protocol is http/https; handling strategy: reject unsupported protocol.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported for web fetching');
  }

  //audit assumption: credentials in URLs are sensitive and unnecessary for this fetcher; failure risk: secret leakage in logs/telemetry and SSRF abuse; expected invariant: URL credentials absent; handling strategy: reject credential-bearing URLs.
  if (parsed.username || parsed.password) {
    throw new Error('URLs containing credentials are not allowed for web fetching');
  }

  return parsed;
}

function buildLinkBlock(links: FetchAndCleanLinkSummary[]): string {
  return links.length > 0
    ? `\n\n[LINKS]\n- ${links.map((link) => `${link.label} -> ${link.url}`).join('\n- ')}`
    : '';
}

/**
 * Purpose: Serialize cleaned text plus discovered links into the legacy string contract.
 * Inputs/Outputs: structured fetch document + max chars -> compact string payload.
 * Edge cases: Preserves the historical `[LINKS]` suffix while truncating the full payload safely.
 */
export function serializeFetchAndCleanDocument(
  document: Pick<FetchAndCleanDocument, 'text' | 'links'>,
  maxChars = getConfiguredMaxChars()
): string {
  const linkBlock = buildLinkBlock(document.links);
  return `${document.text}${linkBlock}`.slice(0, Math.min(Math.max(0, maxChars), HARD_MAX_CHARS));
}

/**
 * Purpose: Fetch a web page through SSRF-safe URL resolution and return structured cleaned content.
 * Inputs/Outputs: URL + optional max chars -> normalized text, absolute links, and legacy combined payload.
 * Edge cases: Blocks private/internal IP targets, enforces DNS-rebinding-safe host pinning,
 * and allows localhost only with explicit non-production opt-in.
 */
export async function fetchAndCleanDocument(
  url: string,
  maxChars = getConfiguredMaxChars(),
  options: FetchAndCleanOptions = {}
): Promise<FetchAndCleanDocument> {
  const fetchStartedAt = Date.now();
  const target = await resolveFetchTarget(url);
  const maxFetchBytes = getConfiguredMaxFetchBytes();
  const boundedMaxChars = Math.min(Math.max(0, maxChars), HARD_MAX_CHARS);
  const fetchTimeoutMs = Math.min(
    Math.max(1, options.timeoutMs ?? getConfiguredFetchTimeoutMs()),
    HARD_MAX_FETCH_TIMEOUT_MS
  );
  const httpsAgent =
    target.parsedUrl.protocol === 'https:'
      ? new HttpsAgent({
          //audit assumption: HTTPS requests to pinned IPs still need hostname verification; failure risk: TLS validation failure or weakened cert checks; expected invariant: certificate validated against original hostname; handling strategy: set explicit SNI servername.
          servername: target.tlsServerName
        })
      : undefined;

  const response = await axios.get<string>(target.requestUrl.toString(), {
    data: undefined,
    timeout: fetchTimeoutMs,
    signal: options.signal,
    maxContentLength: maxFetchBytes,
    maxBodyLength: maxFetchBytes,
    // SSRF safety: redirects would bypass resolveFetchTarget IP pinning and Host/SNI controls.
    maxRedirects: 0,
    // SSRF safety: environment proxies can reroute a pinned request through an unvalidated target.
    proxy: false,
    responseType: 'text',
    headers: {
      Host: target.hostHeader,
      'User-Agent': getConfiguredUserAgent(),
      Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8'
    },
    httpsAgent
  });
  const fetchElapsedMs = Date.now() - fetchStartedAt;

  const contentType = String(response.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType && !['text/html', 'text/plain', 'application/xhtml+xml', 'application/json'].includes(contentType)) {
    throw new Error(`Unsupported content type for web fetching: ${contentType}`);
  }
  const responseText = typeof response.data === 'string' ? response.data : String(response.data ?? '');
  const binarySample = responseText.slice(0, 8192);
  const binaryControlCount = binarySample.match(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/g)?.length ?? 0;
  if (binarySample.includes('\u0000') || binaryControlCount / Math.max(1, binarySample.length) > 0.03) {
    throw new Error('Unsupported binary-like content for web fetching');
  }

  if (options.onRawDocument) {
    const rawDocumentMaxChars = Math.min(
      Math.max(0, options.rawDocumentMaxChars ?? boundedMaxChars),
      HARD_MAX_FETCH_BYTES
    );
    try {
      options.onRawDocument({
        body: responseText.slice(0, rawDocumentMaxChars),
        contentType,
        truncated: responseText.length > rawDocumentMaxChars
      });
    } catch {
      // Optional caller-owned raw-document inspection must not break the safe article fallback.
    }
  }

  const extractionStartedAt = Date.now();
  const $ = load(responseText);
  $('script, style, noscript').remove();
  const rawTextLength = normalizeExtractedText($('body').text()).length;
  for (const selector of (options.removeSelectors ?? []).slice(0, MAX_EXTRACTION_SELECTORS * 4)) {
    try {
      $(selector).remove();
    } catch {
      // Optional caller-owned extraction selectors must never break the generic body fallback.
    }
  }
  $('br').replaceWith(' ');
  $('p, h1, h2, h3, h4, h5, h6, li, dt, dd, div, section, article, tr, td').append(' ');

  const bodyText = normalizeExtractedText($('body').text());
  const bodyElement = $('body').get(0);
  const bodyCandidate = bodyElement
    ? scoreExtractionCandidate($, bodyElement, 'body', options.preferredContentTerms ?? [])
    : {
        selector: 'body',
        text: bodyText,
        qualityScore: 0,
        termOverlap: 0,
        navigationPenalty: 0,
        navigationDensity: 0,
        linkDensity: 0
      };
  const candidates: ScoredExtractionCandidate[] = [];
  const seenCandidateElements = new Set<cheerio.Element>();
  for (const selector of (options.preferredContentSelectors ?? []).slice(0, MAX_EXTRACTION_SELECTORS)) {
    if (candidates.length >= MAX_EXTRACTION_CANDIDATES) {
      break;
    }
    try {
      $(selector).each((_, element) => {
        if (candidates.length >= MAX_EXTRACTION_CANDIDATES) {
          return false;
        }
        if (seenCandidateElements.has(element)) {
          return;
        }
        seenCandidateElements.add(element);
        candidates.push(scoreExtractionCandidate(
          $,
          element,
          selector,
          options.preferredContentTerms ?? []
        ));
      });
    } catch {
      // Invalid optional selectors degrade to the next selector and then the generic body.
    }
  }

  const bestPreferredCandidate = candidates.reduce<ScoredExtractionCandidate | undefined>((best, candidate) => {
    if (!best || candidate.qualityScore > best.qualityScore) {
      return candidate;
    }
    if (candidate.qualityScore === best.qualityScore && candidate.termOverlap > best.termOverlap) {
      return candidate;
    }
    if (
      candidate.qualityScore === best.qualityScore &&
      candidate.termOverlap === best.termOverlap &&
      candidate.text.length > best.text.length
    ) {
      return candidate;
    }
    return best;
  }, undefined);
  const minimumUsefulLength = bodyText.length < 120 ? 1 : 80;
  const selectedCandidate = bestPreferredCandidate &&
    bestPreferredCandidate.text.length >= minimumUsefulLength &&
    bestPreferredCandidate.qualityScore >= MIN_PREFERRED_CONTAINER_SCORE
    ? bestPreferredCandidate
    : bodyCandidate;
  const cleanedText = selectedCandidate.text;
  const extractionStrategy = selectedCandidate.selector;
  const documentTitle = boundExtractionMetadata($('title').first().text());

  options.onExtraction?.({
    strategy: extractionStrategy,
    rawTextLength,
    cleanedTextLength: cleanedText.length,
    fetchElapsedMs,
    extractionElapsedMs: Date.now() - extractionStartedAt,
    selectedContainer: selectedCandidate.selector,
    qualityScore: roundUnitMetric(selectedCandidate.qualityScore),
    navigationPenalty: roundUnitMetric(selectedCandidate.navigationPenalty),
    navigationDensity: roundUnitMetric(selectedCandidate.navigationDensity),
    linkDensity: roundUnitMetric(selectedCandidate.linkDensity),
    candidateCount: candidates.length,
    ...(documentTitle ? { documentTitle } : {}),
    ...(selectedCandidate.headingText ? { headingText: selectedCandidate.headingText } : {})
  });

  const seenLinks = new Set<string>();
  const links: FetchAndCleanLinkSummary[] = [];
  $('a[href]').slice(0, HARD_MAX_LINKS * 4).each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    try {
      const resolved = new URL(href, target.parsedUrl);
      if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
        return;
      }

      if (seenLinks.has(resolved.href)) {
        return;
      }
      seenLinks.add(resolved.href);

      const anchorText = $(el).text().replace(/\s+/g, ' ').trim();
      const label = anchorText || resolved.href;
      links.push({ label, url: resolved.href });
    } catch {
      return;
    }
  });

  const limitedLinks = options.includeLinks === false
    ? []
    : links.slice(0, getConfiguredWebFetchMaxLinks());

  return {
    text: cleanedText,
    links: limitedLinks,
    combined: serializeFetchAndCleanDocument({ text: cleanedText, links: limitedLinks }, boundedMaxChars)
  };
}

/**
 * Purpose: Fetch a web page through SSRF-safe URL resolution and return cleaned text.
 * Inputs/Outputs: URL + optional max chars -> cleaned page text string.
 * Edge cases: Preserves the historical compact string payload for existing callers.
 */
export async function fetchAndClean(
  url: string,
  maxChars = getConfiguredMaxChars(),
  options: FetchAndCleanOptions = {}
): Promise<string> {
  const document = await fetchAndCleanDocument(url, maxChars, options);
  return document.combined;
}

/**
 * Purpose: Backward-compatible wrapper around global fetch for JSON/text responses.
 * Inputs/Outputs: URL + RequestInit -> parsed JSON object or raw text.
 * Edge cases: Throws detailed errors for non-2xx responses and JSON parse failures.
 */
export async function webFetcher<T = unknown>(
  url: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(url, options);

  const contentType = res.headers.get('content-type') || '';
  const bodyText = await res.text();

  if (!res.ok) {
    const snippet = bodyText.replace(/\s+/g, ' ').trim().slice(0, 300);
    const bodyInfo = snippet ? ` Body: ${snippet}` : '';
    throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}.${bodyInfo}`);
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(bodyText) as T;
    } catch (err) {
      throw new Error(`Failed to parse JSON response from ${url}: ${(err as Error).message}`);
    }
  }

  return bodyText as unknown as T;
}

export default webFetcher;

function isLocalhostIdentifier(hostname: string): boolean {
  const normalizedHostname = normalizeIpAddress(hostname).toLowerCase();
  return normalizedHostname === 'localhost' || normalizedHostname === '127.0.0.1' || normalizedHostname === '::1';
}

function isLocalDevelopmentBypassEnabled(hostname: string): boolean {
  const runtimeEnvironment = (process.env.NODE_ENV || '').toLowerCase();
  //audit assumption: localhost bypass is needed only for controlled local development/testing; failure risk: broad environment bypass weakens SSRF defenses; expected invariant: bypass requires explicit flag and non-production mode; handling strategy: gate by env + dedicated opt-in flag + localhost-only hostnames.
  if (runtimeEnvironment !== 'development' && runtimeEnvironment !== 'test') {
    return false;
  }
  if (process.env[LOCALHOST_FETCH_FLAG] !== 'true') {
    return false;
  }
  return isLocalhostIdentifier(hostname);
}

function parseIpv4Octets(ipv4Address: string): number[] | null {
  const octets = ipv4Address.split('.').map((segment) => Number(segment));
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function normalizeIpAddress(ipAddress: string): string {
  return ipAddress.startsWith('[') && ipAddress.endsWith(']')
    ? ipAddress.slice(1, -1)
    : ipAddress;
}

function isInternalIpv4(ipv4Address: string): boolean {
  const octets = parseIpv4Octets(ipv4Address);
  if (!octets) {
    return true;
  }

  const [first, second, third] = octets;

  //audit assumption: reserved/private IPv4 ranges are not safe fetch targets; failure risk: SSRF into internal services; expected invariant: externally routable destination; handling strategy: block known internal/reserved ranges.
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 0 && (third === 0 || third === 2)) return true; // IETF special-use and TEST-NET-1.
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true; // RFC 6598 carrier-grade NAT.
  if (first === 198 && (second === 18 || second === 19)) return true; // RFC 2544 benchmarking.
  if (first === 198 && second === 51 && third === 100) return true; // TEST-NET-2.
  if (first === 203 && second === 0 && third === 113) return true; // TEST-NET-3.
  if (first >= 224) return true; // Multicast, reserved, and limited broadcast ranges.

  return false;
}

function extractIpv4MappedIpv6(ipv6Address: string): string | null {
  const normalized = normalizeIpAddress(ipv6Address).toLowerCase();
  if (!normalized.startsWith('::ffff:')) {
    return null;
  }

  const mappedIpv4 = normalized.slice('::ffff:'.length);
  if (isIP(mappedIpv4) === 4) {
    return mappedIpv4;
  }

  const hexWords = mappedIpv4.split(':');
  if (hexWords.length !== 2) {
    return null;
  }

  const [high, low] = hexWords.map((word) => Number.parseInt(word, 16));
  if ([high, low].some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)) {
    return null;
  }

  return [
    (high >> 8) & 0xff,
    high & 0xff,
    (low >> 8) & 0xff,
    low & 0xff
  ].join('.');
}

function isLoopbackIpv6(ipv6Address: string): boolean {
  const normalized = normalizeIpAddress(ipv6Address).toLowerCase();
  if (normalized === '::1') {
    return true;
  }
  const mappedIpv4 = extractIpv4MappedIpv6(normalized);
  return mappedIpv4 !== null && parseIpv4Octets(mappedIpv4)?.[0] === 127;
}

function isInternalIpv6(ipv6Address: string): boolean {
  const normalized = normalizeIpAddress(ipv6Address).toLowerCase();

  //audit assumption: link-local, loopback, unspecified, and ULA IPv6 ranges are internal; failure risk: SSRF to local infrastructure; expected invariant: globally routable address; handling strategy: block internal IPv6 prefixes.
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10
  if (/^fe[c-f]/.test(normalized)) return true; // fec0::/10 deprecated site-local.
  if (normalized.startsWith('ff')) return true; // ff00::/8 multicast.
  if (normalized === '2001:db8' || normalized.startsWith('2001:db8:')) return true; // Documentation prefix.

  const mappedIpv4 = extractIpv4MappedIpv6(normalized);
  if (mappedIpv4 !== null) {
    return isInternalIpv4(mappedIpv4);
  }

  return false;
}

function isInternalIpAddress(ipAddress: string): boolean {
  const normalizedIpAddress = normalizeIpAddress(ipAddress);
  const ipFamily = isIP(normalizedIpAddress);
  if (ipFamily === 4) {
    return isInternalIpv4(normalizedIpAddress);
  }
  if (ipFamily === 6) {
    return isInternalIpv6(normalizedIpAddress);
  }
  return true;
}

function isLoopbackAddress(ipAddress: string): boolean {
  const normalizedIpAddress = normalizeIpAddress(ipAddress);
  const ipFamily = isIP(normalizedIpAddress);
  if (ipFamily === 4) {
    return parseIpv4Octets(normalizedIpAddress)?.[0] === 127;
  }
  if (ipFamily === 6) {
    return isLoopbackIpv6(normalizedIpAddress);
  }
  return false;
}

function assertAllowedResolvedAddress(ipAddress: string, allowLoopbackForLocalDevelopment: boolean): void {
  //audit assumption: resolved address must remain public unless explicit localhost development mode is active; failure risk: DNS-rebinding SSRF to internal networks; expected invariant: non-internal IP destination; handling strategy: reject internal ranges with narrow loopback exception.
  if (isInternalIpAddress(ipAddress)) {
    if (allowLoopbackForLocalDevelopment && isLoopbackAddress(ipAddress)) {
      return;
    }
    throw new Error('Private/internal IP addresses are not allowed for security reasons');
  }
}

function choosePreferredAddress(addresses: Array<{ address: string; family: IpFamily }>): {
  address: string;
  family: IpFamily;
} {
  const preferredIpv4 = addresses.find((entry) => entry.family === 4);
  return preferredIpv4 || addresses[0];
}

function formatPinnedHostname(address: string, family: IpFamily): string {
  const normalizedAddress = normalizeIpAddress(address);
  return family === 6 ? `[${normalizedAddress}]` : normalizedAddress;
}

async function resolveFetchTarget(rawUrl: string): Promise<ResolvedFetchTarget> {
  const parsedUrl = assertHttpUrl(rawUrl);
  const normalizedHostname = normalizeIpAddress(parsedUrl.hostname).toLowerCase();
  const allowLoopbackForLocalDevelopment = isLocalDevelopmentBypassEnabled(normalizedHostname);

  const ipFamily = isIP(normalizedHostname);
  const resolvedAddresses: Array<{ address: string; family: IpFamily }> =
    ipFamily === 0
      ? (await lookup(normalizedHostname, { all: true, verbatim: true }) as Array<{ address: string; family: IpFamily }>)
      : [{ address: normalizedHostname, family: ipFamily as IpFamily }];

  //audit assumption: DNS lookup must yield at least one concrete address; failure risk: empty resolution bypasses validation path; expected invariant: one or more resolved addresses; handling strategy: hard fail on empty result.
  if (resolvedAddresses.length === 0) {
    throw new Error('Failed to resolve URL hostname to an IP address');
  }

  //audit assumption: all resolved addresses must be validated, not just the first record; failure risk: mixed public/private DNS answers enabling SSRF via fallback selection; expected invariant: every candidate address is safe; handling strategy: reject if any resolved address is internal.
  for (const entry of resolvedAddresses) {
    assertAllowedResolvedAddress(entry.address, allowLoopbackForLocalDevelopment);
  }

  const selectedAddress = choosePreferredAddress(resolvedAddresses);
  const requestUrl = new URL(parsedUrl.toString());
  requestUrl.hostname = formatPinnedHostname(selectedAddress.address, selectedAddress.family);

  return {
    parsedUrl,
    requestUrl,
    hostHeader: parsedUrl.host,
    tlsServerName: parsedUrl.hostname
  };
}
