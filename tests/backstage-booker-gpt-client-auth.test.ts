import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

import {
  BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY,
  backstageBookerAccessAuthMiddleware,
  getAuthenticatedGptClientIdentity,
  getBackstageBookerAccessLegacyActorKey,
  optionalBackstageBookerAccessActorMiddleware,
} from '../src/services/backstageBookerAccessAuth.js';

const configuredToken = `booker-registry-${'a'.repeat(48)}`;
const rotatedToken = `booker-registry-${'b'.repeat(48)}`;
const originalToken = process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;

interface TestRequestOptions {
  authorization?: string;
  rawHeaders?: string[];
  body?: Record<string, unknown>;
}

function buildRequest(options: TestRequestOptions = {}): Request {
  const authorization = options.authorization;
  return {
    method: 'POST',
    body: options.body ?? {},
    headers: authorization === undefined ? {} : { authorization },
    rawHeaders: options.rawHeaders
      ?? (authorization === undefined ? [] : ['Authorization', authorization]),
    header(name: string) {
      return name.toLowerCase() === 'authorization' ? authorization : undefined;
    },
    logger: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  } as unknown as Request;
}

function buildResponse(): Response {
  const response = {
    setHeader: jest.fn(),
    status: jest.fn(),
    json: jest.fn(),
  };
  response.status.mockReturnValue(response);
  return response as unknown as Response;
}

function runRequiredAuth(req: Request): {
  response: Response;
  next: ReturnType<typeof jest.fn>;
} {
  const response = buildResponse();
  const next = jest.fn() as ReturnType<typeof jest.fn>;
  backstageBookerAccessAuthMiddleware(
    req,
    response,
    next as unknown as NextFunction
  );
  return { response, next };
}

afterEach(() => {
  if (originalToken === undefined) {
    delete process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN;
  } else {
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = originalToken;
  }
});

describe('Backstage Booker registered GPT client authentication', () => {
  it('binds the correct bearer to immutable server-owned identity and bounded telemetry', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = configuredToken;
    const promptSentinel = 'protected-prompt-must-not-be-logged';
    const notionSentinel = 'raw-notion-text-must-not-be-logged';
    const resultSentinel = 'generated-result-must-not-be-logged';
    const req = buildRequest({
      authorization: `Bearer ${configuredToken}`,
      body: {
        clientId: 'attacker-client',
        gptId: 'attacker-gpt',
        authenticationType: 'oauth',
        registeredModelProfile: 'pro',
        runtimeModel: 'pro',
        modelIdentityAssurance: 'openai-attested',
        authenticatedUser: { subject: 'attacker' },
        providerModel: 'gpt-5.1',
        prompt: promptSentinel,
        notion: notionSentinel,
        result: resultSentinel,
      },
    });

    const { next } = runRequiredAuth(req);
    const identity = getAuthenticatedGptClientIdentity(req);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.authenticatedActorKey).toBe(
      BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY
    );
    expect(identity).toEqual({
      clientId: 'backstage-booker',
      gptId: 'backstage-booker',
      authenticationType: 'managed-api-key',
      registeredModelProfile: null,
      runtimeModel: null,
      modelIdentityAssurance: 'unknown',
    });
    expect(Object.isFrozen(identity)).toBe(true);

    expect(req.logger?.info).toHaveBeenCalledWith(
      'backstage_booker_access.authenticated',
      {
        authMode: 'dedicated',
        capabilityId: 'BACKSTAGE:BOOKER',
        method: 'POST',
        clientId: 'backstage-booker',
        gptId: 'backstage-booker',
        authenticationType: 'managed-api-key',
        registeredModelProfile: null,
        modelIdentityAssurance: 'unknown',
      }
    );

    const serializedIdentityAndLogs = JSON.stringify({
      identity,
      logs: (req.logger?.info as ReturnType<typeof jest.fn>).mock.calls,
    });
    for (const secretValue of [
      configuredToken,
      promptSentinel,
      notionSentinel,
      resultSentinel,
      'gpt-5.1',
    ]) {
      expect(serializedIdentityAndLogs).not.toContain(secretValue);
    }
  });

  it.each([
    ['incorrect', `Bearer wrong-${'x'.repeat(48)}`, undefined],
    ['missing', undefined, undefined],
    ['malformed scheme', `Basic ${configuredToken}`, undefined],
    ['malformed whitespace', `Bearer  ${configuredToken}`, undefined],
    [
      'duplicate',
      `Bearer ${configuredToken}`,
      [
        'Authorization',
        `Bearer ${configuredToken}`,
        'Authorization',
        `Bearer ${configuredToken}`,
      ],
    ],
  ])('does not resolve a client for %s Authorization', (
    _caseName,
    authorization,
    rawHeaders
  ) => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = configuredToken;
    const req = buildRequest({ authorization, rawHeaders });

    const { response, next } = runRequiredAuth(req);

    expect(next).not.toHaveBeenCalled();
    expect(response.status).toHaveBeenCalledWith(401);
    expect(getAuthenticatedGptClientIdentity(req)).toBeNull();
    expect(req.authenticatedActorKey).toBeUndefined();
  });

  it('does not attach identity when optional authentication has no bearer', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = configuredToken;
    const req = buildRequest();
    const next = jest.fn();

    optionalBackstageBookerAccessActorMiddleware(
      req,
      buildResponse(),
      next as unknown as NextFunction
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(getAuthenticatedGptClientIdentity(req)).toBeNull();
  });

  it('preserves the stable client and owner principal across bearer rotation', () => {
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = configuredToken;
    const firstRequest = buildRequest({
      authorization: `Bearer ${configuredToken}`,
    });
    runRequiredAuth(firstRequest);

    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = rotatedToken;
    const secondRequest = buildRequest({
      authorization: `Bearer ${rotatedToken}`,
    });
    runRequiredAuth(secondRequest);

    expect(getAuthenticatedGptClientIdentity(firstRequest)).toEqual(
      getAuthenticatedGptClientIdentity(secondRequest)
    );
    expect(firstRequest.authenticatedActorKey).toBe(
      BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY
    );
    expect(secondRequest.authenticatedActorKey).toBe(
      BACKSTAGE_BOOKER_ACCESS_PRINCIPAL_ACTOR_KEY
    );
    expect(getBackstageBookerAccessLegacyActorKey(firstRequest)).not.toBe(
      getBackstageBookerAccessLegacyActorKey(secondRequest)
    );

    const privateState = JSON.stringify([
      ...Object.getOwnPropertySymbols(firstRequest).map(
        symbol => (firstRequest as unknown as Record<symbol, unknown>)[symbol]
      ),
      ...Object.getOwnPropertySymbols(secondRequest).map(
        symbol => (secondRequest as unknown as Record<symbol, unknown>)[symbol]
      ),
    ]);
    expect(privateState).not.toContain(configuredToken);
    expect(privateState).not.toContain(rotatedToken);
  });
});
