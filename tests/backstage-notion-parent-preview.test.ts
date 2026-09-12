import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import request from 'supertest';

const actual = await import('../src/shared/backstage/backstageNotionContextCore.js');
const readMetadata = jest.fn(actual.fetchBackstageNotionPageMetadata);
const readTitle = jest.fn(actual.fetchBackstageNotionPageTitleProperty);
jest.unstable_mockModule('../src/shared/backstage/backstageNotionContextCore.js', () => ({
  ...actual,
  fetchBackstageNotionPageMetadata: readMetadata,
  fetchBackstageNotionPageTitleProperty: readTitle,
}));
const { createNativePrPreviewApplication } = await import('../src/nativePrPreviewApplication.js');
const { NATIVE_PR_PREVIEW_BACKSTAGE_GENERATION_CONTRACT: contract } = await import('../src/nativePrPreviewContract.js');

const databaseParentRowId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
const privateDiagnostic = 'PRIVATE-NOTION-PARENT-PREVIEW-DIAGNOSTIC';

function application() {
  return createNativePrPreviewApplication({
    identity: { prNumber: 1501, sourceCommit: 'a'.repeat(40) },
    readinessState: {
      applicationImported: true, fixturesSealed: true, ready: true, draining: false,
    },
    notionConnectivityProbe: async () => ({
      apiReached: true, authenticationRejected: true,
    }),
  });
}

async function query() {
  return request(application()).post(contract.path)
    .send({ fixture: contract.fixtures.notionAuthorityRag });
}

describe('served Notion parent compatibility proof boundary', () => {
  beforeEach(() => {
    readMetadata.mockReset().mockImplementation(actual.fetchBackstageNotionPageMetadata);
    readTitle.mockReset().mockImplementation(actual.fetchBackstageNotionPageTitleProperty);
  });

  it('hydrates and rechecks the database-parent title before emitting additive proof', async () => {
    const response = await query();
    expect(response.status).toBe(200);
    expect(response.headers[contract.proofHeaders.notionDatabaseAuthorityVersion])
      .toBe('backstage-notion-database-authority/v1');
    expect(response.headers[contract.proofHeaders.notionParentCompatibilityVersion])
      .toBe('backstage-notion-parent-compatibility/v1');
    const titleCalls = readTitle.mock.calls.filter(call => call[2] === databaseParentRowId);
    expect(titleCalls).toHaveLength(4);
    expect(titleCalls.map(call => call[3]))
      .toEqual([null, 'opaque title cursor/\u96ea:v1', null, 'opaque title cursor/\u96ea:v1']);
    expect(response.body.databaseBoundaryReached).toBe(false);
    expect(response.body.providerBoundaryReached).toBe(false);
    expect(response.body.protectedEffectsEnabled).toBe(false);
    expect(JSON.stringify([response.body, response.headers])).not.toContain(databaseParentRowId);
  });

  it.each([
    'parent identity drift',
    'fabricated source membership',
    'incomplete title marked complete',
    'truncated hydrated title',
    'malformed parent admitted',
    'malformed title fragment admitted',
    'unexpected parser failure',
  ])('withholds every generation proof and success body after %s', async scenario => {
    readMetadata.mockImplementation(async (...args) => {
      if (args[2] === databaseParentRowId && scenario === 'unexpected parser failure') {
        throw new Error(privateDiagnostic);
      }
      let metadata;
      try {
        metadata = await actual.fetchBackstageNotionPageMetadata(...args);
      } catch (error) {
        if (scenario === 'malformed parent admitted'
          && error instanceof actual.BackstageNotionReadError
          && error.notionRejectionCode === 'page_parent') {
          return {
            pageId: databaseParentRowId, parentPageId: null, parentDataSourceId: null,
            parentType: 'database_id', parentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
            lastEditedAt: new Date('2026-09-12T12:00:00.000Z'), inTrash: false,
          };
        }
        throw error;
      }
      if (args[2] !== databaseParentRowId) return metadata;
      if (scenario === 'parent identity drift') {
        return { ...metadata, parentId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' };
      }
      if (scenario === 'fabricated source membership') {
        return { ...metadata, parentDataSourceId: metadata.parentId };
      }
      if (scenario === 'incomplete title marked complete') {
        return { ...metadata, titleIsComplete: true };
      }
      return metadata;
    });
    readTitle.mockImplementation(async (...args) => {
      try {
        const title = await actual.fetchBackstageNotionPageTitleProperty(...args);
        return scenario === 'truncated hydrated title' && args[2] === databaseParentRowId
          && !title.hasMore ? { ...title, titleParts: [] } : title;
      } catch (error) {
        if (scenario === 'malformed title fragment admitted'
          && error instanceof actual.BackstageNotionReadError
          && error.notionRejectionCode === 'page_title_fragment') {
          return { titleParts: [privateDiagnostic], hasMore: false, nextCursor: null };
        }
        throw error;
      }
    });

    const response = await query();
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error: 'PREVIEW_REQUEST_INVALID' });
    for (const header of Object.values(contract.proofHeaders)) {
      expect(response.headers[header]).toBeUndefined();
    }
    expect(response.text).not.toContain(privateDiagnostic);
    expect(response.text).not.toContain('current_complete');
    expect(response.text).not.toContain('notionAuthority');
    expect(response.headers['cache-control']).toContain('no-store');
  });
});
