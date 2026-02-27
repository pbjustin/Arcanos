import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';

const originalEnv = process.env;

describe('confirmGate trusted GPT hardening', () => {
  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.ALLOW_ALL_GPTS = 'false';
    process.env.TRUSTED_GPT_IDS = 'trusted-gpt-123';
    delete process.env.ARCANOS_AUTOMATION_SECRET;
    delete process.env.ARCANOS_AUTOMATION_HEADER;
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetModules();
  });

  it('does not bypass confirmation with only a trusted gptId in request body', async () => {
    const { confirmGate } = await import('../src/transport/http/middleware/confirmGate.js');

    const mockReq = {
      method: 'POST',
      path: '/api/protected',
      headers: {},
      body: { gptId: 'trusted-gpt-123' }
    } as unknown as Request;

    const status = jest.fn().mockReturnThis();
    const json = jest.fn().mockReturnThis();
    const setHeader = jest.fn();
    const mockRes = { status, json, setHeader } as unknown as Response;
    const next = jest.fn() as NextFunction;

    confirmGate(mockReq, mockRes, next);

    expect(next).not.toHaveBeenCalled();
    expect(status).toHaveBeenCalledWith(403);
  });
});
