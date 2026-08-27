import {
  createGptClientRegistry,
  gptClientRegistry,
  type GptClientRegistrationDefinition,
} from '../src/shared/gpt/gptClientRegistry.js';

describe('server-owned GPT client registry', () => {
  it('registers Backstage Booker with an exact non-attested identity', () => {
    expect(gptClientRegistry.resolveRegisteredClient('backstage-booker')).toEqual({
      clientId: 'backstage-booker',
      gptId: 'backstage-booker',
      displayName: 'Backstage Booker',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
      status: 'active',
    });

    expect(gptClientRegistry.resolveAuthenticatedClient({
      clientId: 'backstage-booker',
      authentication: { authenticationType: 'managed-api-key' },
    })).toEqual({
      clientId: 'backstage-booker',
      gptId: 'backstage-booker',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
    });
  });

  it('fails closed for unknown, inactive, duplicate, and malformed registrations', () => {
    expect(gptClientRegistry.resolveAuthenticatedClient({
      clientId: 'unknown-client',
      authentication: { authenticationType: 'managed-api-key' },
    })).toBeNull();

    const inactiveRegistry = createGptClientRegistry([{
      clientId: 'inactive-client',
      gptId: 'inactive-gpt',
      displayName: 'Inactive client',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      status: 'inactive',
    }]);
    expect(inactiveRegistry.resolveAuthenticatedClient({
      clientId: 'inactive-client',
      authentication: { authenticationType: 'managed-api-key' },
    })).toBeNull();

    const duplicate = {
      clientId: 'duplicate-client',
      gptId: 'duplicate-gpt',
      displayName: 'Duplicate client',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      status: 'active',
    } as const;
    expect(() => createGptClientRegistry([duplicate, duplicate])).toThrow(
      'Duplicate GPT client registration'
    );

    const malformedProfile = {
      ...duplicate,
      clientId: 'malformed-profile',
      registeredModelProfile: 'gpt-5.6-pro',
    } as unknown as GptClientRegistrationDefinition;
    expect(() => createGptClientRegistry([malformedProfile])).toThrow(
      'unknown model profile'
    );
  });

  it('keeps a registered profile distinct from an actual runtime model', () => {
    const profiledRegistry = createGptClientRegistry([{
      clientId: 'profiled-client',
      gptId: 'profiled-gpt',
      displayName: 'Profiled client',
      authenticationType: 'managed-api-key',
      registeredModelProfile: 'pro',
      status: 'active',
    }]);

    expect(profiledRegistry.resolveAuthenticatedClient({
      clientId: 'profiled-client',
      authentication: { authenticationType: 'managed-api-key' },
    })).toEqual({
      clientId: 'profiled-client',
      gptId: 'profiled-gpt',
      authenticationType: 'managed-api-key',
      registeredModelProfile: 'pro',
      runtimeModel: null,
      modelIdentityAssurance: 'credential-bound-profile',
    });
  });

  it('ignores caller model, provider model, and credential fields outside its trusted input', () => {
    const attackerControlledInput = {
      clientId: 'backstage-booker',
      authentication: { authenticationType: 'managed-api-key' as const },
      credential: 'must-never-be-projected',
      runtimeModel: 'gpt-5.6-pro',
      registeredModelProfile: 'pro',
      modelIdentityAssurance: 'openai-attested',
      providerModel: 'gpt-5.1',
    };

    const identity = gptClientRegistry.resolveAuthenticatedClient(
      attackerControlledInput
    );
    expect(identity).toEqual({
      clientId: 'backstage-booker',
      gptId: 'backstage-booker',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
    });
    expect(JSON.stringify(identity)).not.toContain('must-never-be-projected');
    expect(Object.isFrozen(identity)).toBe(true);
  });

  it('keeps future OAuth evidence distinct from managed API-key authentication', () => {
    const oauthRegistry = createGptClientRegistry([{
      clientId: 'oauth-client',
      gptId: 'oauth-gpt',
      displayName: 'OAuth client',
      authenticationType: 'oauth',
      oauthClientId: 'trusted-action-client',
      registeredModelProfile: null,
      status: 'active',
    }]);

    expect(oauthRegistry.resolveAuthenticatedClient({
      clientId: 'oauth-client',
      authentication: { authenticationType: 'managed-api-key' },
    })).toBeNull();
    expect(gptClientRegistry.resolveAuthenticatedClient({
      clientId: 'backstage-booker',
      authentication: {
        authenticationType: 'oauth',
        authenticatedUser: {
          subject: 'user-1',
          oauthClientId: 'trusted-action-client',
          scopes: ['bookings:write'],
        },
      },
    })).toBeNull();
    expect(oauthRegistry.resolveAuthenticatedClient({
      clientId: 'oauth-client',
      authentication: {
        authenticationType: 'oauth',
      },
    } as never)).toBeNull();
    expect(oauthRegistry.resolveAuthenticatedClient({
      clientId: 'oauth-client',
      authentication: {
        authenticationType: 'oauth',
        authenticatedUser: {
          subject: 'user-1',
          oauthClientId: 'wrong-action-client',
          scopes: ['bookings:write'],
        },
      },
    })).toBeNull();

    const identity = oauthRegistry.resolveAuthenticatedClient({
      clientId: 'oauth-client',
      authentication: {
        authenticationType: 'oauth',
        authenticatedUser: {
          subject: 'user-1',
          oauthClientId: 'trusted-action-client',
          scopes: ['bookings:read', 'bookings:write'],
        },
      },
    });
    expect(identity).toEqual({
      clientId: 'oauth-client',
      gptId: 'oauth-gpt',
      authenticationType: 'oauth',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
      authenticatedUser: {
        subject: 'user-1',
        oauthClientId: 'trusted-action-client',
        scopes: ['bookings:read', 'bookings:write'],
      },
    });
    expect(Object.isFrozen(identity?.authenticatedUser.scopes)).toBe(true);
  });
});
