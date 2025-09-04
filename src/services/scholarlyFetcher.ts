import axios from 'axios';

export interface ScholarlySource {
  title: string;
  authors: string[];
  journal: string;
  year: string;
  url: string;
}

/**
 * Query the CrossRef API for scholarly works related to a topic.
 * Returns simplified metadata for each source.
 */
export async function searchScholarly(
  query: string,
  rows: number = 3
): Promise<ScholarlySource[]> {
  try {
    const response = await axios.get('https://api.crossref.org/works', {
      params: { query, rows }
    });

    const items = response.data?.message?.items || [];

    return items.map((item: any) => ({
      title: item.title?.[0] || 'Untitled',
      authors: (item.author || []).map(
        (a: any) => `${a.given ?? ''} ${a.family ?? ''}`.trim()
      ),
      journal: item['container-title']?.[0] || '',
      year:
        item['published-print']?.['date-parts']?.[0]?.[0]?.toString() ||
        item['published-online']?.['date-parts']?.[0]?.[0]?.toString() ||
        '',
      url: item.URL
    }));
  } catch (err) {
    console.error('searchScholarly error:', err);
    return [];
  }
}

export default { searchScholarly };
