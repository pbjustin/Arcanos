import axios from 'axios';
import { load } from 'cheerio';

const DEFAULT_MAX_CHARS = 12000;

/**
 * Validates URL and prevents SSRF attacks by blocking private/internal IPs
 * @param rawUrl - URL string to validate
 * @returns Validated URL object
 * @throws Error if URL is invalid or points to private/internal network
 */
function assertHttpUrl(rawUrl: string): URL {
  if (!rawUrl || !rawUrl.trim()) {
    throw new Error('A URL is required for web fetching');
  }

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported for web fetching');
  }

  // SSRF protection: Block private/internal IP addresses
  const hostname = parsed.hostname.toLowerCase();
  
  // During tests we allow localhost/private IPs so the test harness can
  // start ephemeral servers bound to 127.0.0.1. In non-test environments
  // keep strict SSRF protections. //audit: assumption=test
  if (process.env.NODE_ENV !== 'test') {
    // Block localhost variants
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') {
      throw new Error('Localhost URLs are not allowed for security reasons');
    }

    // Block private IP ranges (RFC 1918)
    const privateIpPatterns = [
      /^10\./,                    // 10.0.0.0/8
      /^172\.(1[6-9]|2[0-9]|3[01])\./,  // 172.16.0.0/12
      /^192\.168\./,              // 192.168.0.0/16
      /^169\.254\./,              // Link-local (169.254.0.0/16)
      /^127\./,                   // Loopback (127.0.0.0/8)
    ];

    // Check if hostname matches private IP pattern
    if (privateIpPatterns.some(pattern => pattern.test(hostname))) {
      throw new Error('Private/internal IP addresses are not allowed for security reasons');
    }

    // Block IPv6 private ranges
    if (hostname.startsWith('fc00:') || hostname.startsWith('fe80:') || hostname.startsWith('::')) {
      throw new Error('Private/internal IPv6 addresses are not allowed for security reasons');
    }
  } else {
    //audit: In test mode we skip private/localhost checks to allow test servers.
  }

  return parsed;
}

/**
 * Fetches a URL and returns cleaned text content.
 * Removes script and style tags, condenses whitespace, and truncates overly long pages.
 */
export async function fetchAndClean(url: string, maxChars = DEFAULT_MAX_CHARS): Promise<string> {
  const parsed = assertHttpUrl(url);
  const { data } = await axios.get<string>(parsed.toString(), {
    timeout: 8000,
    maxContentLength: 1_500_000,
    responseType: 'text',
    headers: {
      'User-Agent': 'Arcanos-WebFetcher/1.0',
      Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8'
    }
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
      const resolved = new URL(href, parsed);
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

export { assertHttpUrl };
