import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { runWithRequestAbortTimeout } from '@arcanos/runtime';
import type { NextFunction, Request, Response } from 'express';
import { PURPOSE_BOUND_CREDENTIAL_ENV_NAMES } from '../src/shared/security/purposeBoundCredential.js';
import {
  isBackstageNotionEnrichmentAuthorized,
  isBackstageProtectedQueuedExecution,
  markBackstageNotionEnrichmentUsed,
  optionalBackstageNotionEnrichmentAuth,
  runWithBackstageProtectedQueuedExecution,
  wasBackstageNotionEnrichmentUsed,
} from '../src/services/backstageNotionEnrichmentAuthorization.js';

const accessToken = `backstage-${'a'.repeat(48)}`;
const originalEnvironment = new Map<string, string | undefined>();

function buildRequest(options: {
  gptId?: string;
  authorization?: string;
  body?: Record<string, unknown>;
} = {}): Request {
  const authorization = options.authorization;
  return {
    params: { gptId: options.gptId ?? 'backstage-booker' },
    body: options.body ?? {},
    rawHeaders: authorization ? ['authorization', authorization] : [],
    header(name: string) {
      return name.toLowerCase() === 'authorization' ? authorization : undefined;
    },
  } as unknown as Request;
}

async function readAuthorizationInsideNext(req: Request): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const next: NextFunction = (error?: unknown) => {
      if (error) {
        reject(error);
        return;
      }
      setImmediate(() => resolve(isBackstageNotionEnrichmentAuthorized()));
    };
    optionalBackstageNotionEnrichmentAuth(req, {} as Response, next);
  });
}

describe('optional Backstage Notion enrichment authorization', () => {
  beforeEach(() => {
    for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      originalEnvironment.set(name, process.env[name]);
      delete process.env[name];
    }
    process.env.ARCANOS_BACKSTAGE_BOOKER_ACCESS_TOKEN = accessToken;
  });

  afterEach(() => {
    for (const name of PURPOSE_BOUND_CREDENTIAL_ENV_NAMES) {
      const original = originalEnvironment.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
    originalEnvironment.clear();
  });

  it('establishes request-local provenance only for the verified dedicated bearer', async () => {
    await expect(readAuthorizationInsideNext(buildRequest({
      authorization: `Bearer ${accessToken}`,
    }))).resolves.toBe(true);
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
  });

  it('establishes a stable server-derived actor key without retaining the bearer', async () => {
    const firstRequest = buildRequest({ authorization: `Bearer ${accessToken}` });
    const secondRequest = buildRequest({ authorization: `Bearer ${accessToken}` });

    optionalBackstageNotionEnrichmentAuth(firstRequest, {} as Response, () => undefined);
    optionalBackstageNotionEnrichmentAuth(secondRequest, {} as Response, () => undefined);

    expect(firstRequest.authenticatedActorKey).toMatch(/^backstage-booker-access:/u);
    expect(secondRequest.authenticatedActorKey).toBe(firstRequest.authenticatedActorKey);
    expect(firstRequest.authenticatedActorKey).not.toContain(accessToken);
    expect(firstRequest).not.toHaveProperty('authorization');
  });

  it('keeps protected queue provenance worker-local and authorization-compatible', async () => {
    const inside = runWithBackstageProtectedQueuedExecution(true, () => ({
      authorized: isBackstageNotionEnrichmentAuthorized(),
      protectedQueue: isBackstageProtectedQueuedExecution(),
    }));

    expect(inside).toEqual({ authorized: true, protectedQueue: true });
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
    expect(isBackstageProtectedQueuedExecution()).toBe(false);
  });

  it('keeps missing and invalid credentials unauthorized for non-authority fallback policy', async () => {
    await expect(readAuthorizationInsideNext(buildRequest())).resolves.toBe(false);
    await expect(readAuthorizationInsideNext(buildRequest({
      authorization: `Bearer ${'wrong'.repeat(12)}`,
    }))).resolves.toBe(false);
  });

  it('does not trust payload fields that imitate authorization state', async () => {
    await expect(readAuthorizationInsideNext(buildRequest({
      body: {
        backstageNotionEnrichmentAuthorized: true,
        authorized: true,
      },
    }))).resolves.toBe(false);
  });

  it('does not establish the context for unrelated GPT routes', async () => {
    await expect(readAuthorizationInsideNext(buildRequest({
      gptId: 'arcanos-core',
      authorization: `Bearer ${accessToken}`,
    }))).resolves.toBe(false);
  });

  it('does not establish the context when the route parameter is absent', async () => {
    const request = buildRequest({ authorization: `Bearer ${accessToken}` });
    request.params = {};

    await expect(readAuthorizationInsideNext(request)).resolves.toBe(false);
  });

  it.each([
    'backstage',
    'BACKSTAGE-BOOKER',
    ' backstage-booker ',
  ])('does not establish provenance for noncanonical Backstage GPT ID %s', async (gptId) => {
    await expect(readAuthorizationInsideNext(buildRequest({
      gptId,
      authorization: `Bearer ${accessToken}`,
    }))).resolves.toBe(false);
  });

  it('preserves verified provenance through the nested route timeout context', async () => {
    const authorized = await new Promise<boolean>((resolve, reject) => {
      const request = buildRequest({ authorization: `Bearer ${accessToken}` });
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        void runWithRequestAbortTimeout(
          { timeoutMs: 1_000 },
          async () => {
            await Promise.resolve();
            return isBackstageNotionEnrichmentAuthorized();
          }
        ).then(resolve, reject);
      };
      optionalBackstageNotionEnrichmentAuth(request, {} as Response, next);
    });

    expect(authorized).toBe(true);
    expect(isBackstageNotionEnrichmentAuthorized()).toBe(false);
  });

  it('tracks sensitive-context use only inside an authorized request context', async () => {
    const usedInsideRequest = await new Promise<boolean>((resolve, reject) => {
      const request = buildRequest({ authorization: `Bearer ${accessToken}` });
      const next: NextFunction = (error?: unknown) => {
        if (error) {
          reject(error);
          return;
        }
        markBackstageNotionEnrichmentUsed();
        setImmediate(() => resolve(wasBackstageNotionEnrichmentUsed()));
      };
      optionalBackstageNotionEnrichmentAuth(request, {} as Response, next);
    });

    expect(usedInsideRequest).toBe(true);
    expect(wasBackstageNotionEnrichmentUsed()).toBe(false);
    markBackstageNotionEnrichmentUsed();
    expect(wasBackstageNotionEnrichmentUsed()).toBe(false);
  });
});
