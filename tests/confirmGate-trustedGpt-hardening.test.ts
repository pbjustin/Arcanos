import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const originalEnv = process.env;
const trustedId = 'trusted-gpt-123';

function requestWithIdentity(source: 'path' | 'body' | 'header', token?: string): Request {
  return {
    method: 'POST',
    path: '/api/protected',
    params: source === 'path' ? { gptId: trustedId } : {},
    body: source === 'body' ? { gptId: trustedId } : {},
    headers: {
      ...(source === 'header' ? { 'x-gpt-id': trustedId } : {}),
      ...(token === undefined ? {} : { 'x-arcanos-confirm-token': token }),
    },
  } as unknown as Request;
}

function responseRecorder() {
  const status = jest.fn().mockReturnThis();
  const json = jest.fn().mockReturnThis();
  const setHeader = jest.fn();
  return { status, json, setHeader, response: { status, json, setHeader } as unknown as Response };
}

describe('confirmGate trusted GPT hardening', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ALLOW_ALL_GPTS = 'false';
    process.env.TRUSTED_GPT_IDS = trustedId;
    process.env.ARCANOS_AUTOMATION_SECRET = 'synthetic-automation-secret';
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-synthetic-automation';
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
    jest.resetModules();
  });

  describe.each(['path', 'body', 'header'] as const)('%s GPT metadata', source => {
    it.each([undefined, '', 'synthetic-invalid-token'])('rejects missing or invalid token %s', async token => {
      const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');
      const req = requestWithIdentity(source, token);
      const recorder = responseRecorder();
      const next = jest.fn();

      confirmGate(req, recorder.response, next);

      expect(next).not.toHaveBeenCalled();
      expect(recorder.status).toHaveBeenCalledWith(403);
      expect(req.confirmationContext).toBeUndefined();
    });

    it('consumes a legitimate token once and rejects replay', async () => {
      const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const { token } = createOneTimeToken();
      const req = requestWithIdentity(source, token);
      const approved = responseRecorder();
      const next = jest.fn();

      confirmGate(req, approved.response, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(req.confirmationContext).toMatchObject({
        confirmationStatus: 'one-time-token', usedOneTimeToken: true, isTrustedGpt: true,
        automationSecretApproved: false,
      });
      const replay = responseRecorder();
      confirmGate(requestWithIdentity(source, token), replay.response, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(replay.status).toHaveBeenCalledWith(403);
    });

    it('rejects an expired token', async () => {
      const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');
      const { createOneTimeToken } = await import('../src/lib/tokenStore.js');
      const record = createOneTimeToken();
      jest.spyOn(Date, 'now').mockReturnValue(record.expiresAt);
      const recorder = responseRecorder();
      const next = jest.fn();

      confirmGate(requestWithIdentity(source, record.token), recorder.response, next);

      expect(next).not.toHaveBeenCalled();
      expect(recorder.status).toHaveBeenCalledWith(403);
    });
  });

  it('preserves authenticated automation approval independently of GPT metadata', async () => {
    const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');
    const req = requestWithIdentity('body', 'synthetic-invalid-token');
    req.headers['x-synthetic-automation'] = 'synthetic-automation-secret';
    const next = jest.fn();
    confirmGate(req, responseRecorder().response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.confirmationContext).toMatchObject({
      confirmationStatus: 'automation-secret', automationSecretApproved: true, usedOneTimeToken: false,
    });

    const denied = requestWithIdentity('body', 'synthetic-invalid-token');
    denied.headers['x-synthetic-automation'] = 'wrong-automation-secret';
    const recorder = responseRecorder();
    confirmGate(denied, recorder.response, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(recorder.status).toHaveBeenCalledWith(403);
  });

  it('preserves challenge-only approval and rejects other approvals without consuming their token', async () => {
    const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');
    const { createOneTimeToken, consumeOneTimeToken } = await import('../src/lib/tokenStore.js');
    const { token } = createOneTimeToken();
    const req = requestWithIdentity('body', token);
    req.headers['x-confirmed'] = 'yes';
    req.headers['x-synthetic-automation'] = 'synthetic-automation-secret';
    const options = {
      requireChallengeToken: true,
      challengeBinding: { actorKey: 'synthetic-actor', principalId: 'synthetic-principal', workspaceId: 'synthetic-workspace' },
    };
    const pending = responseRecorder();
    const next = jest.fn();
    confirmGate(req, pending.response, next, options);
    expect(next).not.toHaveBeenCalled();
    expect(pending.status).toHaveBeenCalledWith(403);
    expect(consumeOneTimeToken(token).ok).toBe(true);

    const challenge = pending.setHeader.mock.calls.find(([name]) => name === 'x-confirmation-challenge')?.[1];
    expect(challenge).toEqual(expect.any(String));
    const confirmed = requestWithIdentity('body');
    confirmed.headers['x-confirmed'] = `token:${challenge}`;
    confirmGate(confirmed, responseRecorder().response, next, options);
    expect(next).toHaveBeenCalledTimes(1);
    expect(confirmed.confirmationContext).toMatchObject({
      confirmationStatus: 'challenge-token', usedChallengeToken: true, usedOneTimeToken: false,
    });
    const replay = responseRecorder();
    confirmGate(confirmed, replay.response, next, options);
    expect(next).toHaveBeenCalledTimes(1);
    expect(replay.status).toHaveBeenCalledWith(403);
  });
});
