import axios from 'axios';
import { load } from 'cheerio';

const DEFAULT_MAX_CHARS = 12000;

function assertHttpUrl(rawUrl: string): URL {
  if (!rawUrl || !rawUrl.trim()) {
    throw new Error('A URL is required for web fetching');
  }

  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http/https URLs are supported for web fetching');
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
