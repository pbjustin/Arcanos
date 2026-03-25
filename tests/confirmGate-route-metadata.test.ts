import { beforeEach, describe, expect, test, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

process.env.ALLOW_ALL_GPTS = 'false';
process.env.TRUSTED_GPT_IDS = '';

const { confirmGate } = await import('../src/middleware/confirmGate.js');

describe('confirmGate middleware - legacy route metadata', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;
  let setHeaderMock: jest.Mock;
  let getHeaderMock: jest.Mock;

  beforeEach(() => {
    statusMock = jest.fn().mockReturnThis();
    jsonMock = jest.fn();
    setHeaderMock = jest.fn();
    getHeaderMock = jest.fn((headerName: string) => {
      switch (headerName) {
        case 'x-canonical-route':
          return '/gpt/arcanos-core';
        case 'x-route-deprecated':
          return 'true';
        case 'x-ask-route-mode':
          return 'compat';
        case 'Sunset':
          return 'Wed, 01 Jul 2026 00:00:00 GMT';
        default:
          return undefined;
      }
    });

    mockReq = {
      method: 'POST',
      path: '/api/arcanos/ask',
      headers: {},
      body: {}
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
      setHeader: setHeaderMock,
      getHeader: getHeaderMock
    } as Partial<Response>;

    mockNext = jest.fn();
  });

  test('includes canonical route metadata when blocking a deprecated compatibility route', () => {
    confirmGate(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).not.toHaveBeenCalled();
    expect(statusMock).toHaveBeenCalledWith(403);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'CONFIRMATION_REQUIRED',
        canonicalRoute: '/gpt/arcanos-core',
        deprecated: true,
        routeMode: 'compat',
        sunsetAt: 'Wed, 01 Jul 2026 00:00:00 GMT'
      })
    );
  });
});
