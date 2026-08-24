import { describe, expect, test } from '@jest/globals';

import {
  classifyBackstageNotionPageMaterials,
  hashBackstageNotionPageMaterial,
  type BackstageNotionPageMaterialIdentity,
} from '../src/shared/backstage/backstageNotionPartitionMaterialCore.js';

const ids = {
  added: '11111111-1111-4111-8111-111111111111',
  changed: '22222222-2222-4222-8222-222222222222',
  deleted: '33333333-3333-4333-8333-333333333333',
  moved: '44444444-4444-4444-8444-444444444444',
  unchanged: '55555555-5555-4555-8555-555555555555',
} as const;

function identity(
  pageId: string,
  overrides: Partial<BackstageNotionPageMaterialIdentity> = {}
): BackstageNotionPageMaterialIdentity {
  return {
    pageId,
    contentHash: hashBackstageNotionPageMaterial(`material:${pageId}`),
    parentPageId: null,
    title: 'Current canon',
    path: ['Universe', 'Current canon'],
    ...overrides,
  };
}

describe('Backstage Notion partition material classification', () => {
  test('classifies stable IDs and retains both content and placement change evidence', () => {
    const previous = [
      identity(ids.changed),
      identity(ids.deleted),
      identity(ids.moved),
      identity(ids.unchanged),
    ];
    const current = [
      identity(ids.added),
      identity(ids.changed, {
        contentHash: hashBackstageNotionPageMaterial('changed material'),
        title: 'Renamed and changed',
        path: ['Universe', 'Renamed and changed'],
      }),
      identity(ids.moved, {
        parentPageId: ids.unchanged,
        path: ['Universe', 'Current canon', 'Moved page'],
      }),
      identity(ids.unchanged),
    ];

    const byId = new Map(classifyBackstageNotionPageMaterials(previous, current)
      .map(classification => [classification.pageId, classification]));

    expect(byId.get(ids.added)).toMatchObject({
      state: 'added',
      contentChanged: false,
      placementChanged: false,
      previous: null,
    });
    expect(byId.get(ids.deleted)).toMatchObject({ state: 'deleted', current: null });
    expect(byId.get(ids.changed)).toMatchObject({
      state: 'changed',
      contentChanged: true,
      placementChanged: true,
    });
    expect(byId.get(ids.moved)).toMatchObject({
      state: 'moved',
      contentChanged: false,
      placementChanged: true,
    });
    expect(byId.get(ids.unchanged)).toMatchObject({
      state: 'unchanged',
      contentChanged: false,
      placementChanged: false,
    });
  });

  test('hashes sanitized material independently from page identity and placement', () => {
    expect(hashBackstageNotionPageMaterial('# Canon\n')).toBe(
      '6de828ff3718e8231519f9e2b2acb4adb6ac31be75e14e22df71179a24406b4b'
    );
  });

  test('rejects duplicate page ownership in either inventory', () => {
    const duplicated = identity(ids.unchanged);
    expect(() => classifyBackstageNotionPageMaterials(
      [duplicated, duplicated],
      []
    )).toThrow('duplicate page identity');
    expect(() => classifyBackstageNotionPageMaterials(
      [],
      [duplicated, duplicated]
    )).toThrow('duplicate page identity');
  });
});
