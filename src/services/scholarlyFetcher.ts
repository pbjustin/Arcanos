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

    const items = Array.isArray(response.data?.message?.items)
      ? (response.data.message.items as Array<Record<string, unknown>>)
      : [];

    return items.map((item) => ({
      title: getFirstString(item.title) || 'Untitled',
      authors: getAuthors(item.author),
      journal: getFirstString(item['container-title']) || '',
      year:
        getFirstYear(item['published-print']) ||
        getFirstYear(item['published-online']) ||
        '',
      url: typeof item.URL === 'string' ? item.URL : ''
    }));
  } catch (err: unknown) {
    //audit Assumption: API errors should return empty results
    console.error('searchScholarly error:', err instanceof Error ? err.message : err);
    return [];
  }
}

export default { searchScholarly };

function getFirstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === 'string' ? first : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function getAuthors(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(author => {
      if (!author || typeof author !== 'object') {
        return '';
      }
      const record = author as Record<string, unknown>;
      const given = typeof record.given === 'string' ? record.given : '';
      const family = typeof record.family === 'string' ? record.family : '';
      return `${given} ${family}`.trim();
    })
    .filter(Boolean);
}

function getFirstYear(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const dateParts = record['date-parts'];
  if (!Array.isArray(dateParts) || dateParts.length === 0) {
    return undefined;
  }
  const firstRow = dateParts[0];
  if (!Array.isArray(firstRow) || firstRow.length === 0) {
    return undefined;
  }
  const year = firstRow[0];
  return year !== undefined ? String(year) : undefined;
}
