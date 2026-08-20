import { createHash } from 'node:crypto';

export const BACKSTAGE_NOTION_RAG_INDEX_FORMAT =
  'backstage-notion-rag-index-v5';

/**
 * Build the fixed-size locale-stable digest persisted beside user-facing
 * Notion scope text. Hashing after normalization prevents compatibility
 * expansion from turning a bounded raw segment into oversized metadata or SQL
 * parameters. Retrieval cross-checks the selected raw text against the same
 * digest, so a mismatched or corrupt key fails closed.
 */
export function normalizeBackstageNotionScopeKey(value: string): string {
  const normalized = value
    .normalize('NFKC')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
  if (!normalized) {
    throw new Error('Backstage Notion scope text must remain non-empty after normalization.');
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

export function normalizeBackstageNotionScopePath(
  value: readonly string[]
): string[] {
  return value.map(normalizeBackstageNotionScopeKey);
}
