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

  return text.replace(/\s+/g, ' ').trim().slice(0, Math.max(0, maxChars));
}

export { assertHttpUrl };
