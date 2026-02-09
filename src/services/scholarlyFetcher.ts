import axios from 'axios';
import { resolveErrorMessage } from '../lib/errors/index.js';
import { getScholarlyApiConfig } from '../config/scholarly.js';

export interface ScholarlySource {
  title: string;
  authors: string[];
  journal: string;
  year: string;
  url: string;
}

/**
 * Query the CrossRef API for scholarly works related to a topic.
 *
 * Inputs: query string + optional rows override.
 * Outputs: list of simplified scholarly sources.
 * Edge cases: returns an empty list when the API fails or returns unexpected shapes.
 */
export async function searchScholarly(
  query: string,
  rows?: number
): Promise<ScholarlySource[]> {
  const scholarlyConfig = getScholarlyApiConfig();
  //audit Assumption: caller may omit rows; risk: undefined rows causing API defaults; invariant: rows is a positive integer; handling: use config defaultRows.
  const requestedRows = Number.isInteger(rows) && rows > 0 ? rows : scholarlyConfig.defaultRows;
  try {
    const response = await axios.get(scholarlyConfig.endpoint, {
      params: { query, rows: requestedRows },
      timeout: scholarlyConfig.timeoutMs,
    });

    //audit Assumption: response data is shaped per CrossRef spec; risk: missing fields; invariant: items is always an array; handling: fallback to empty array.
    const items = Array.isArray(response.data?.message?.items)
      ? (response.data.message.items as Array<Record<string, unknown>>)
      : [];

    //audit Assumption: mapping is a pure transform; risk: invalid fields; invariant: each output matches ScholarlySource; handling: normalize with helpers and defaults.
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
    //audit Assumption: API errors should return empty results; risk: silent failures in upstream features; invariant: errors are logged; handling: log and return [].
    console.error('searchScholarly error:', resolveErrorMessage(err));
    return [];
  }
}

export default { searchScholarly };

function getFirstString(value: unknown): string | undefined {
  //audit Assumption: first item is representative; risk: non-string arrays; invariant: return string or undefined; handling: type-check per branch.
  if (Array.isArray(value)) {
    const first = value[0];
    //audit Assumption: array values may be mixed; risk: unexpected types; invariant: strings only; handling: return undefined if not string.
    return typeof first === 'string' ? first : undefined;
  }
  //audit Assumption: single values may be string; risk: other primitives; invariant: return string or undefined; handling: type-check.
  return typeof value === 'string' ? value : undefined;
}

function getAuthors(value: unknown): string[] {
  //audit Assumption: author list should be array; risk: null/invalid shape; invariant: return array; handling: fallback to [].
  if (!Array.isArray(value)) {
    return [];
  }
  //audit Assumption: transform author records into display names; risk: partial names; invariant: no falsy entries; handling: filter empty strings.
  return value
    .map(author => {
      //audit Assumption: each author entry should be object-like; risk: invalid entries; invariant: return string for each; handling: return empty string for invalid.
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
  //audit Assumption: date metadata is object-like; risk: missing date parts; invariant: return string year or undefined; handling: guard invalid shapes.
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const dateParts = record['date-parts'];
  //audit Assumption: date-parts should be nested arrays; risk: empty arrays; invariant: return undefined on missing; handling: guard length.
  if (!Array.isArray(dateParts) || dateParts.length === 0) {
    return undefined;
  }
  const firstRow = dateParts[0];
  //audit Assumption: first row contains year; risk: empty row; invariant: return undefined if missing; handling: guard length.
  if (!Array.isArray(firstRow) || firstRow.length === 0) {
    return undefined;
  }
  const year = firstRow[0];
  //audit Assumption: year can be coerced; risk: non-number year; invariant: return string or undefined; handling: stringify when defined.
  return year !== undefined ? String(year) : undefined;
}
