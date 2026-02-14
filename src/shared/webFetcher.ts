import axios from 'axios';
import { load } from 'cheerio';
import { lookup } from 'node:dns/promises';
import { Agent as HttpsAgent } from 'node:https';
import { isIP } from 'node:net';

const DEFAULT_MAX_CHARS = 12000;
const LOCALHOST_FETCH_FLAG = 'ARCANOS_ALLOW_LOCALHOST_FETCH';
const MAX_FETCH_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 8000;

type IpFamily = 4 | 6;

interface ResolvedFetchTarget {
  parsedUrl: URL;
  requestUrl: URL;
  hostHeader: string;
  tlsServerName: string;
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

/**
 * Purpose: Fetch a web page through SSRF-safe URL resolution and return cleaned text.
 * Inputs/Outputs: URL + optional max chars -> cleaned page text string.
 * Edge cases: Blocks private/internal IP targets, enforces DNS-rebinding-safe host pinning,
 * and allows localhost only with explicit non-production opt-in.
 */
export async function fetchAndClean(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  const target = await resolveFetchTarget(url);
  const httpsAgent =
    target.parsedUrl.protocol === 'https:'
      ? new HttpsAgent({
          //audit assumption: HTTPS requests to pinned IPs still need hostname verification; failure risk: TLS validation failure or weakened cert checks; expected invariant: certificate validated against original hostname; handling strategy: set explicit SNI servername.
          servername: target.tlsServerName
        })
      : undefined;

  const { data } = await axios.get<string>(target.requestUrl.toString(), {
    timeout: FETCH_TIMEOUT_MS,
    maxContentLength: MAX_FETCH_BYTES,
    maxBodyLength: MAX_FETCH_BYTES,
    maxRedirects: 0,
    responseType: 'text',
    headers: {
      Host: target.hostHeader,
      'User-Agent': 'Arcanos-WebFetcher/1.0',
      Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8'
    },
    httpsAgent
  });

  const $ = load(data);
  $('script, style, noscript').remove();
  const text = $('body').text();
  const cleanedText = text.replace(/\s+/g, ' ').trim();

  const seenLinks = new Set<string>();
  const linkSummaries: string[] = [];
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
      linkSummaries.push(`${label} -> ${resolved.href}`);
    } catch {
      return;
    }
  });

  const linkBlock = linkSummaries.length
    ? `\n\n[LINKS]\n- ${linkSummaries.slice(0, 15).join('\n- ')}`
    : '';

  return `${cleanedText}${linkBlock}`.slice(0, Math.max(0, maxChars));
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
  const normalizedHostname = hostname.toLowerCase();
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

function isInternalIpv4(ipv4Address: string): boolean {
  const octets = parseIpv4Octets(ipv4Address);
  if (!octets) {
    return true;
  }

  const [first, second] = octets;

  //audit assumption: reserved/private IPv4 ranges are not safe fetch targets; failure risk: SSRF into internal services; expected invariant: externally routable destination; handling strategy: block known internal/reserved ranges.
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true; // RFC 6598 carrier-grade NAT.
  if (first === 198 && (second === 18 || second === 19)) return true; // RFC 2544 benchmarking.

  return false;
}

function isLoopbackIpv6(ipv6Address: string): boolean {
  const normalized = ipv6Address.toLowerCase();
  if (normalized === '::1') {
    return true;
  }
  if (!normalized.startsWith('::ffff:')) {
    return false;
  }
  const mappedIpv4 = normalized.slice('::ffff:'.length);
  return isIP(mappedIpv4) === 4 && parseIpv4Octets(mappedIpv4)?.[0] === 127;
}

function isInternalIpv6(ipv6Address: string): boolean {
  const normalized = ipv6Address.toLowerCase();

  //audit assumption: link-local, loopback, unspecified, and ULA IPv6 ranges are internal; failure risk: SSRF to local infrastructure; expected invariant: globally routable address; handling strategy: block internal IPv6 prefixes.
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // fc00::/7
  if (/^fe[89ab]/.test(normalized)) return true; // fe80::/10

  if (normalized.startsWith('::ffff:')) {
    const mappedIpv4 = normalized.slice('::ffff:'.length);
    if (isIP(mappedIpv4) === 4) {
      return isInternalIpv4(mappedIpv4);
    }
  }

  return false;
}

function isInternalIpAddress(ipAddress: string): boolean {
  const ipFamily = isIP(ipAddress);
  if (ipFamily === 4) {
    return isInternalIpv4(ipAddress);
  }
  if (ipFamily === 6) {
    return isInternalIpv6(ipAddress);
  }
  return true;
}

function isLoopbackAddress(ipAddress: string): boolean {
  const ipFamily = isIP(ipAddress);
  if (ipFamily === 4) {
    return parseIpv4Octets(ipAddress)?.[0] === 127;
  }
  if (ipFamily === 6) {
    return isLoopbackIpv6(ipAddress);
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

async function resolveFetchTarget(rawUrl: string): Promise<ResolvedFetchTarget> {
  const parsedUrl = assertHttpUrl(rawUrl);
  const normalizedHostname = parsedUrl.hostname.toLowerCase();
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
  requestUrl.hostname = selectedAddress.address;

  return {
    parsedUrl,
    requestUrl,
    hostHeader: parsedUrl.host,
    tlsServerName: parsedUrl.hostname
  };
}
