import type { Pool } from 'pg';

export const resolvedSourceId = '10000000-0000-4000-8000-000000000001';

/** In-memory SQL boundary for the real repository; this does not emulate PostgreSQL FTS. */
export class GamingResolvedSourceHarness {
  source: Record<string, any> | undefined;
  revisions: Array<Record<string, any>> = [];
  records: Array<Record<string, any>> = [];
  queries: string[] = [];
  readonly pool = {
    connect: async () => ({ query: this.query.bind(this), release: () => undefined }),
    query: this.query.bind(this)
  } as unknown as Pool;

  async query(raw: string, values: any[] = []) {
    const sql = raw.replace(/\s+/gu, ' ').trim();
    this.queries.push(sql);
    const result = (rows: Array<Record<string, any>> = []) => ({ rows, rowCount: rows.length });
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return result();
    if (sql.startsWith('INSERT INTO gaming_sources')) {
      if (this.source) return result();
      this.source = {
        id: resolvedSourceId, game_key: values[0], game_name: values[1],
        canonical_url: values[2], canonical_url_hash: values[3], public_url: values[4],
        host: values[5], source_type: values[6], trust_score: values[7], priority: values[8],
        status: 'active', last_checked_at: values[9], last_success_at: values[9],
        created_at: values[9], updated_at: values[9]
      };
      return result([this.source]);
    }
    if (sql.endsWith('FOR UPDATE') || sql.startsWith('UPDATE gaming_sources')) {
      return result(this.source ? [this.source] : []);
    }
    if (sql.startsWith('SELECT id FROM gaming_source_revisions')) {
      return result(this.revisions.filter(revision => revision.source_id === values[0]
        && revision.content_hash === values[1] && revision.extractor === values[2]
        && revision.extractor_version === values[3] && revision.normalizer_schema_version === values[4]));
    }
    if (sql.startsWith('INSERT INTO gaming_source_revisions')) {
      const revision = {
        id: `20000000-0000-4000-8000-${String(this.revisions.length + 1).padStart(12, '0')}`,
        source_id: values[0], content_hash: values[1], cleaned_content: values[2],
        etag: values[3], last_modified: values[4], fetched_at: values[5],
        published_at: values[6], patch: values[7], extractor: values[8],
        extractor_version: values[9], normalizer_schema_version: values[10],
        provenance: JSON.parse(values[11]), extraction_metrics: JSON.parse(values[12])
      };
      this.revisions.push(revision);
      return result([revision]);
    }
    if (sql.startsWith('UPDATE gaming_knowledge_records AS knowledge')) {
      const superseded = this.records.filter(record => record.source_revision_id !== values[1]
        && record.status === 'active');
      superseded.forEach(record => { record.status = 'superseded'; });
      return result(superseded);
    }
    if (sql.startsWith('INSERT INTO gaming_knowledge_records')) {
      const inserted = JSON.parse(values[2]).map((record: Record<string, any>, index: number) => ({
        ...record, id: `record-${this.records.length + index + 1}`, source_revision_id: values[0],
        game_key: values[1], status: 'active', created_at: new Date()
      }));
      this.records.push(...inserted);
      return result(inserted);
    }
    if (sql.includes('LEFT JOIN LATERAL')) {
      const latest = this.revisions.at(-1);
      return result(this.source ? [{ ...this.source, ...Object.fromEntries(
        Object.entries(latest ?? {}).map(([key, value]) => [`latest_${key}`, value])
      ), latest_revision_id: latest?.id }] : []);
    }
    if (sql.startsWith('WITH search_input')) {
      // Model only literal topic matches; the existing repository suites own SQL shape checks.
      const words = String(values[1]).toLowerCase().match(/[a-z0-9]+/gu) ?? [];
      return result(this.records.filter(record => record.status === 'active'
        && this.source?.status === 'active' && record.game_key === values[0]
        && (!values[2] || record.record_type === values[2])
        && words.every(word => record.search_text.toLowerCase().includes(word)))
        .slice(0, values[3]).map(record => {
          const revision = this.revisions.find(item => item.id === record.source_revision_id)!;
          return {
            ...this.source, ...record, ...revision, record_id: record.id,
            record_patch: record.patch, record_created_at: record.created_at,
            source_id: this.source?.id, revision_id: revision.id, revision_patch: revision.patch,
            relevance: 1
          };
        }));
    }
    throw new Error('Unexpected SQL operation in Gaming fixture');
  }
}
