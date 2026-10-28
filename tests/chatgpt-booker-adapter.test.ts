import express, { type Request, type Response } from 'express';
import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { ChatGptPrincipal } from '../src/chatgpt/auth.js';
import {
  createBookerTokenVerifier, readBookerAuthConfiguration, type ReadyBookerAuthConfiguration,
} from '../src/chatgpt/bookerAuth.js';
import { BOOKER_MCP_PATH, BOOKER_READ_SCOPE } from '../src/shared/chatgpt/bookerMcpContract.js';
import { buildBackstageBookerProtectedFailureState } from '../src/shared/backstage/backstageBookerAsyncContinuation.js';

const route = jest.fn<(req: Request, res: Response) => void>();
jest.unstable_mockModule('../src/routes/gptRouter.js', () => {
  const router = express.Router();
  router.post('/backstage-booker', route);
  return { default: router };
});
const { invokeBookerGptAction } = await import('../src/chatgpt/bookerGptAdapter.js');

const universeId = 'adapter-fixture-universe';
const input = { universeId, query: 'Summarize my universe.', retrievalMode: 'relevant' };
const configuration = readBookerAuthConfiguration(name => ({
  CHATGPT_BOOKER_ENABLED: 'true', CHATGPT_BOOKER_ISSUER: 'https://booker-issuer.invalid/',
  CHATGPT_BOOKER_RESOURCE: 'https://booker-resource.invalid' + BOOKER_MCP_PATH,
  CHATGPT_BOOKER_JWKS_URL: 'https://booker-issuer.invalid/jwks', CHATGPT_BOOKER_OWNER_SUBJECT: 'fixture-owner',
  CHATGPT_BOOKER_UNIVERSE_ID: universeId, CHATGPT_BOOKER_OAUTH_CLIENT_ID: 'fixture-client',
})[name]) as ReadyBookerAuthConfiguration;
let principal: ChatGptPrincipal;
beforeAll(async () => {
  const keys = await generateKeyPair('RS256');
  const keyResolver = createLocalJWKSet({ keys: [{ ...await exportJWK(keys.publicKey), kid: 'fixture', alg: 'RS256' }] });
  const now = Math.floor(Date.now() / 1000);
  const token = await new SignJWT({ iss: configuration.issuer, aud: configuration.resource, sub: configuration.ownerSubject,
    iat: now, exp: now + 300, client_id: configuration.oauthClientId, scope: BOOKER_READ_SCOPE,
  }).setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'fixture' }).sign(keys.privateKey);
  const verified = await createBookerTokenVerifier(configuration, { keyResolver, readEnvironmentValue: () => undefined })('Bearer ' + token);
  if (!verified.ok) throw new Error('Signed fixture rejected');
  principal = verified.principal;
});
beforeEach(() => route.mockReset());

describe('Booker canonical response capture', () => {
  it('captures a JSON object across UTF-8 byte chunks without changing its shape', async () => {
    const body = { ok: true, result: { universeId, answer: 'Continuity 🎤', sources: [{ pagePath: ['Universe', 'Raw'] }] } };
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    const split = bytes.indexOf(Buffer.from('🎤', 'utf8')) + 1;
    route.mockImplementation((_req, res) => {
      res.write(bytes.subarray(0, split));
      res.end(bytes.subarray(split));
    });
    expect(await invokeBookerGptAction(principal, 'queryContinuity', input)).toEqual({ statusCode: 200, result: body });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it.each([409, 429, 500, 503])('preserves an HTTP %s backend failure verbatim', async statusCode => {
    const body = { ok: false, ...buildBackstageBookerProtectedFailureState({
      code: statusCode === 409 ? 'BACKSTAGE_NOTION_CURSOR_INVALID' : 'BACKSTAGE_NOTION_INDEX_UNAVAILABLE',
      message: 'Synthetic backend failure.',
    }), requestId: 'fixture-request', traceId: 'fixture-trace' };
    route.mockImplementation((_req, res) => { res.status(statusCode).json(body); });
    expect(await invokeBookerGptAction(principal, 'queryContinuity', input)).toEqual({ statusCode, result: body });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('keeps backend execution exceptions distinct from invalid response capture', async () => {
    const failure = new Error('Synthetic backend execution failure.');
    route.mockImplementation(() => { throw failure; });
    await expect(invokeBookerGptAction(principal, 'queryContinuity', input)).rejects.toBe(failure);
    expect(route).toHaveBeenCalledTimes(1);
  });

  it.each(['{"private":"notion-private-sentinel"', 'null', '[]', '"notion-private-sentinel"', '42'])
  ('classifies malformed or non-object capture without exposing its body (%#)', async serialized => {
    route.mockImplementation((_req, res) => { res.end(serialized); });
    await expect(invokeBookerGptAction(principal, 'queryContinuity', input)).rejects.toMatchObject({
      code: 'BOOKER_OUTPUT_INVALID', message: 'BOOKER_OUTPUT_INVALID',
    });
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('classifies a response exceeding the capture byte cap without exposing its body', async () => {
    route.mockImplementation((_req, res) => { res.end(JSON.stringify({ private: 'x'.repeat(4 * 1024 * 1024) })); });
    await expect(invokeBookerGptAction(principal, 'queryContinuity', input)).rejects.toMatchObject({
      code: 'BOOKER_OUTPUT_INVALID', message: 'BOOKER_OUTPUT_INVALID',
    });
    expect(route).toHaveBeenCalledTimes(1);
  });
});
