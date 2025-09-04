import axios from 'axios';
import { load } from 'cheerio';

/**
 * Fetches a URL and returns cleaned text content.
 * Removes script and style tags and condenses whitespace.
 */
export async function fetchAndClean(url: string): Promise<string> {
  const { data } = await axios.get<string>(url);
  const $ = load(data);
  $('script, style').remove();
  const text = $('body').text();
  return text.replace(/\s+/g, ' ').trim();
}
