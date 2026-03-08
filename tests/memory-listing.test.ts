import { describe, expect, it } from '@jest/globals';

import { buildActiveMemorySelect, normalizeMemoryEntries } from '../src/services/memoryListing.js';

describe('memoryListing helpers', () => {
  it('builds a latest-active query without a prefix filter', () => {
    const statement = buildActiveMemorySelect(25, null);

    expect(statement).toEqual({
      text:
        'SELECT key, value, created_at, updated_at, expires_at FROM memory WHERE (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT $1',
      params: [25]
    });
  });

  it('builds a latest-active query with a prefix filter', () => {
    const statement = buildActiveMemorySelect(10, 'session:demo:');

    expect(statement).toEqual({
      text:
        'SELECT key, value, created_at, updated_at, expires_at FROM memory WHERE key ILIKE $2 AND (expires_at IS NULL OR expires_at > NOW()) ORDER BY updated_at DESC LIMIT $1',
      params: [10, 'session:demo:%']
    });
  });

  it('normalizes rows into MCP-safe plain objects with ISO timestamps', () => {
    const entries = normalizeMemoryEntries([
      {
        key: 'memory:demo',
        value: {
          metadata: {
            versionId: 'memory-1',
            monotonicTimestampMs: 42
          },
          payload: {
            summary: 'stored value'
          }
        },
        created_at: new Date('2026-03-08T01:02:03.000Z'),
        updated_at: '2026-03-08T01:03:04.000Z',
        expires_at: null
      }
    ]);

    expect(entries).toEqual([
      {
        key: 'memory:demo',
        value: {
          summary: 'stored value'
        },
        metadata: {
          versionId: 'memory-1',
          monotonicTimestampMs: 42
        },
        created_at: '2026-03-08T01:02:03.000Z',
        updated_at: '2026-03-08T01:03:04.000Z',
        expires_at: null
      }
    ]);
  });

  it('keeps legacy payloads readable and falls back invalid timestamps deterministically', () => {
    const entries = normalizeMemoryEntries([
      {
        key: 'memory:legacy',
        value: 'legacy string payload',
        created_at: 'not-a-date',
        updated_at: 'also-not-a-date',
        expires_at: '2026-03-08T01:05:00.000Z'
      }
    ]);

    expect(entries).toEqual([
      {
        key: 'memory:legacy',
        value: 'legacy string payload',
        metadata: null,
        created_at: '1970-01-01T00:00:00.000Z',
        updated_at: '1970-01-01T00:00:00.000Z',
        expires_at: '2026-03-08T01:05:00.000Z'
      }
    ]);
  });
});
