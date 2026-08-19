import { describe, expect, it } from '@jest/globals';
import {
  BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME,
  parseBackstageNotionAuthorityConfiguration,
  resolveBackstageNotionAuthorityRoot as resolveConfiguredRoot,
} from '../src/shared/backstage/backstageNotionAuthorityCore.js';
import {
  isBackstageNotionAuthoritativeUniverse,
  resolveEffectiveBackstageNotionAuthorityRoot,
  readBackstageNotionAuthorityConfiguration,
  resolveBackstageNotionAuthorityRoot,
} from '../src/services/backstageNotionAuthority.js';

const universeId = 'my-universe-2k26';
const rootPageId = '21F5A0FF752E8065A204E1735B744185';
const normalizedRootPageId = '21f5a0ff-752e-8065-a204-e1735b744185';

function environmentReader(rawValue: string | undefined) {
  return (name: string): string | undefined => (
    name === BACKSTAGE_NOTION_AUTHORITY_ROOTS_ENV_NAME ? rawValue : undefined
  );
}

describe('Backstage Notion authority configuration', () => {
  it('distinguishes absent, invalid, and valid configuration', () => {
    expect(parseBackstageNotionAuthorityConfiguration(undefined)).toEqual({
      status: 'absent',
      roots: [],
    });
    expect(parseBackstageNotionAuthorityConfiguration('{bad json')).toEqual({
      status: 'invalid',
      roots: [],
      reason: 'invalid_json',
    });

    const configuration = parseBackstageNotionAuthorityConfiguration(
      JSON.stringify({
        [universeId]: {
          rootPageId,
          displayName: 'WWE Universe Mode',
          initialMinimumPageCount: 18,
        },
      })
    );

    expect(configuration).toEqual({
      status: 'valid',
      roots: [{
        universeId,
        rootPageId: normalizedRootPageId,
        displayName: 'WWE Universe Mode',
        initialMinimumPageCount: 18,
      }],
    });
    expect(Object.isFrozen(configuration)).toBe(true);
    expect(Object.isFrozen(configuration.roots)).toBe(true);
  });

  it.each([
    {},
    { [universeId]: { rootPageId, displayName: 'WWE', unexpected: true } },
    { [universeId]: { rootPageId, displayName: ' WWE' } },
    { [universeId]: { rootPageId: `https://notion.so/${rootPageId}`, displayName: 'WWE' } },
    { [universeId]: { rootPageId, displayName: 'WWE', initialMinimumPageCount: 0 } },
    { [universeId]: { rootPageId, displayName: 'WWE', initialMinimumPageCount: 513 } },
    {
      [universeId]: { rootPageId, displayName: 'WWE' },
      other: { rootPageId, displayName: 'Duplicate root' },
    },
  ])('rejects unsafe or ambiguous closed mappings %#', (value) => {
    expect(parseBackstageNotionAuthorityConfiguration(
      JSON.stringify(value)
    )).toMatchObject({ status: 'invalid', reason: 'invalid_shape' });
  });

  it('resolves universe IDs exactly and exposes every configured root', () => {
    const rawValue = JSON.stringify({
      [universeId]: { rootPageId, displayName: 'WWE Universe Mode' },
      'secondary-universe': {
        rootPageId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Secondary Universe',
      },
    });
    const configuration = readBackstageNotionAuthorityConfiguration({
      readEnvironment: environmentReader(rawValue),
    });

    expect(configuration.status).toBe('valid');
    expect(configuration.roots).toHaveLength(2);
    expect(resolveConfiguredRoot(configuration, universeId)).toMatchObject({
      rootPageId: normalizedRootPageId,
    });
    expect(resolveConfiguredRoot(configuration, universeId.toUpperCase())).toBeNull();
    expect(resolveBackstageNotionAuthorityRoot(universeId, {
      readEnvironment: environmentReader(rawValue),
    })).toMatchObject({ displayName: 'WWE Universe Mode' });
  });

  it('fails closed for mutation guards when present configuration is invalid', () => {
    expect(isBackstageNotionAuthoritativeUniverse('any-universe', {
      readEnvironment: environmentReader('{bad json'),
    })).toBe(true);
    expect(isBackstageNotionAuthoritativeUniverse(universeId, {
      readEnvironment: environmentReader(undefined),
    })).toBe(false);
    expect(isBackstageNotionAuthoritativeUniverse('unmapped', {
      readEnvironment: environmentReader(JSON.stringify({
        [universeId]: { rootPageId, displayName: 'WWE Universe Mode' },
      })),
    })).toBe(false);
  });

  it('classifies environment-reader exceptions without exposing the exception', () => {
    expect(readBackstageNotionAuthorityConfiguration({
      readEnvironment: () => {
        throw new Error('sensitive environment detail');
      },
    })).toEqual({
      status: 'invalid',
      roots: [],
      reason: 'environment_read_failed',
    });
  });

  it('keeps a persisted Notion authority active when the mapping is absent', async () => {
    const root = await resolveEffectiveBackstageNotionAuthorityRoot(universeId, {
      readEnvironment: environmentReader(undefined),
      repository: {
        loadAuthorityHead: async () => ({
          universeId,
          authority: 'notion',
          activeSnapshotId: '11111111-1111-4111-8111-111111111111',
          rootPageId: normalizedRootPageId,
        }),
      },
    });

    expect(root).toEqual({
      universeId,
      rootPageId: normalizedRootPageId,
      displayName: universeId,
    });
  });

  it('fails closed when configured and persisted roots conflict', async () => {
    await expect(resolveEffectiveBackstageNotionAuthorityRoot(universeId, {
      readEnvironment: environmentReader(JSON.stringify({
        [universeId]: { rootPageId, displayName: 'WWE Universe Mode' },
      })),
      repository: {
        loadAuthorityHead: async () => ({
          universeId,
          authority: 'notion',
          activeSnapshotId: '11111111-1111-4111-8111-111111111111',
          rootPageId: '22222222-2222-4222-8222-222222222222',
        }),
      },
    })).rejects.toMatchObject({
      name: 'BackstageNotionAuthorityUnavailableError',
      code: 'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE',
      httpStatus: 503,
      retryable: true,
    });
  });

  it('denies an unknown authority state instead of treating it as PostgreSQL', async () => {
    await expect(resolveEffectiveBackstageNotionAuthorityRoot(universeId, {
      readEnvironment: environmentReader(undefined),
      repository: {
        loadAuthorityHead: async () => {
          throw new Error('postgres://private-user:private-password@internal/authority');
        },
      },
    })).rejects.toMatchObject({
      code: 'BACKSTAGE_NOTION_AUTHORITY_UNAVAILABLE',
      message: 'The Backstage Notion authority state is temporarily unavailable.',
    });
  });

  it('uses an exact valid mapping to keep legacy paths closed during a database outage', async () => {
    const root = await resolveEffectiveBackstageNotionAuthorityRoot(universeId, {
      readEnvironment: environmentReader(JSON.stringify({
        [universeId]: { rootPageId, displayName: 'WWE Universe Mode' },
      })),
      repository: {
        loadAuthorityHead: async () => {
          throw new Error('database unavailable');
        },
      },
    });

    expect(root).toMatchObject({
      universeId,
      rootPageId: normalizedRootPageId,
    });
  });
});
