import axios from 'axios';

export async function fetchWebSearch(query: string): Promise<string> {
  try {
    const url = `https://r.jina.ai/https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const res = await axios.get(url, { timeout: 10000 });
    const text = typeof res.data === 'string' ? res.data : JSON.stringify(res.data);
    return text.replace(/<[^>]+>/g, ' ').slice(0, 2000);
  } catch (error: any) {
    console.error('Web search failed:', error.message);
    return `No results for ${query}`;
  }
}
