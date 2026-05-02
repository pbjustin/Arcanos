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

type IpFamily = 4 | 6;

interface ResolvedFetchTarget {
  parsedUrl: URL;
  requestUrl: URL;
  hostHeader: string;
  tlsServerName: string;
}

function getConfiguredMaxChars(): number {
  return getEnvIntegerAtLeast('WEB_FETCH_MAX_CHARS', DEFAULT_MAX_CHARS, 0);
}

function getConfiguredFetchTimeoutMs(): number {
  return getEnvIntegerAtLeast('WEB_FETCH_TIMEOUT_MS', DEFAULT_FETCH_TIMEOUT_MS, 1);
}

function getConfiguredMaxFetchBytes(): number {
  return getEnvIntegerAtLeast('WEB_FETCH_MAX_BYTES', DEFAULT_MAX_FETCH_BYTES, 1);
}

export function getConfiguredWebFetchMaxLinks(): number {
  return getEnvIntegerAtLeast('WEB_FETCH_MAX_LINKS', DEFAULT_MAX_LINKS, 0);
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
  return `${document.text}${linkBlock}`.slice(0, Math.max(0, maxChars));
}

/**
 * Purpose: Fetch a web page through SSRF-safe URL resolution and return structured cleaned content.
 * Inputs/Outputs: URL + optional max chars -> normalized text, absolute links, and legacy combined payload.
 * Edge cases: Blocks private/internal IP targets, enforces DNS-rebinding-safe host pinning,
 * and allows localhost only with explicit non-production opt-in.
 */
export async function fetchAndCleanDocument(
  url: string,
  maxChars = getConfiguredMaxChars()
): Promise<FetchAndCleanDocument> {
  const target = await resolveFetchTarget(url);
  const maxFetchBytes = getConfiguredMaxFetchBytes();
  const httpsAgent =
    target.parsedUrl.protocol === 'https:'
      ? new HttpsAgent({
          //audit assumption: HTTPS requests to pinned IPs still need hostname verification; failure risk: TLS validation failure or weakened cert checks; expected invariant: certificate validated against original hostname; handling strategy: set explicit SNI servername.
          servername: target.tlsServerName
        })
      : undefined;

  const { data } = await axios.get<string>(target.requestUrl.toString(), {
    timeout: getConfiguredFetchTimeoutMs(),
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

  const $ = load(data);
  $('script, style, noscript').remove();
  const text = $('body').text();
  const cleanedText = text.replace(/\s+/g, ' ').trim();

  const seenLinks = new Set<string>();
  const links: FetchAndCleanLinkSummary[] = [];
  $('a[href]').each((_, el) => {
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

  const limitedLinks = links.slice(0, getConfiguredWebFetchMaxLinks());

  return {
    text: cleanedText,
    links: limitedLinks,
    combined: serializeFetchAndCleanDocument({ text: cleanedText, links: limitedLinks }, maxChars)
  };
}

/**
 * Purpose: Fetch a web page through SSRF-safe URL resolution and return cleaned text.
 * Inputs/Outputs: URL + optional max chars -> cleaned page text string.
 * Edge cases: Preserves the historical compact string payload for existing callers.
 */
export async function fetchAndClean(url: string, maxChars = getConfiguredMaxChars()): Promise<string> {
  const document = await fetchAndCleanDocument(url, maxChars);
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
