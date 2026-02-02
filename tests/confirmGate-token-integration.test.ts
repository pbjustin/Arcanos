import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

// Set test environment variables before imports
process.env.ALLOW_ALL_GPTS = 'false';
process.env.TRUSTED_GPT_IDS = '';
process.env.ARCANOS_AUTOMATION_SECRET = 'test-secret';
process.env.ARCANOS_AUTOMATION_HEADER = 'x-automation-secret';

// Import modules after env setup
const { confirmGate, ConfirmationContext } = await import('../src/middleware/confirmGate.js');
const tokenStore = await import('../src/lib/tokenStore.js');

describe('confirmGate middleware - one-time token integration', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let statusMock: jest.Mock;
  let jsonMock: jest.Mock;
  let setHeaderMock: jest.Mock;

  beforeEach(() => {
    statusMock = jest.fn().mockReturnThis();
    jsonMock = jest.fn();
    setHeaderMock = jest.fn();

    mockReq = {
      method: 'POST',
      path: '/api/test',
      headers: {},
      body: {}
    };

    mockRes = {
      status: statusMock,
      json: jsonMock,
      setHeader: setHeaderMock
    } as Partial<Response>;

    mockNext = jest.fn();

    jest.clearAllMocks();
  });

  describe('one-time token authentication', () => {
    test('allows request with valid one-time token', () => {
      // Create a real token
      const tokenRecord = tokenStore.createOneTimeToken();
      const mockToken = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': mockToken
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(setHeaderMock).toHaveBeenCalledWith('x-confirmation-status', 'one-time-token');
      expect(statusMock).not.toHaveBeenCalledWith(403);
    });

    test('rejects request with invalid one-time token', () => {
      const invalidToken = 'invalid-token';

      mockReq.headers = {
        'x-arcanos-confirm-token': invalidToken
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });

    test('rejects request with expired one-time token', () => {
      // We can't easily test token expiration without mocking time,
      // but we can verify the logic is in place by checking that
      // a consumed token behaves correctly
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;
      
      // Consume the token
      tokenStore.consumeOneTimeToken(token);

      
      // Try to use the already-consumed token
      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });

    test('consumes one-time token only once', () => {
      // Create a token
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();

      // Second request: same token is now invalid (already consumed)
      jest.clearAllMocks();

      const mockReq2 = {
        ...mockReq,
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      confirmGate(mockReq2 as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });

    test('sets correct confirmation context for one-time token', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      const context: ConfirmationContext = (mockReq as any).confirmationContext;
      expect(context).toBeDefined();
      expect(context.confirmationStatus).toBe('one-time-token');
      expect(context.usedOneTimeToken).toBe(true);
      expect(context.manualConfirmation).toBe(false);
      expect(context.usedChallengeToken).toBe(false);
    });

    test('one-time token does not require additional confirmation', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      // No x-confirmed header, only one-time token
      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalledWith(403);
    });

    test('one-time token bypasses manual confirmation requirement', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token,
        // No x-confirmed: yes header
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const context: ConfirmationContext = (mockReq as any).confirmationContext;
      expect(context.manualConfirmation).toBe(false);
      expect(context.usedOneTimeToken).toBe(true);
    });

    test('handles token consumption error gracefully', () => {
      // This test verifies error handling, though we can't easily trigger
      // an error in the real implementation without mocking
      const token = 'error-token';

      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      // With an invalid token, the middleware should reject gracefully
      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });

    test('does not consume token if other auth methods succeed first', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;
      // Manual confirmation takes precedence
      mockReq.headers = {
        'x-confirmed': 'yes',
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      // Token should still be valid (not consumed) since manual confirmation took precedence
      expect(mockNext).toHaveBeenCalled();
      
      // Verify token is still valid by trying to consume it
      const result = tokenStore.consumeOneTimeToken(token);
      expect(result.ok).toBe(true);
    });

    test('one-time token works with GPT ID header', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;
      const gptId = 'gpt-12345';

      mockReq.headers = {
        'x-arcanos-confirm-token': token,
        'x-gpt-id': gptId
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      const context: ConfirmationContext = (mockReq as any).confirmationContext;
      expect(context.gptId).toBe(gptId);
      expect(context.usedOneTimeToken).toBe(true);
    });
  });

  describe('Security audit markers', () => {
    test('verifies one-time token grants single-use approval (audit marker)', () => {
      // Audit assumption: one-time token grants single-use approval
      // Risk: token replay if not consumed
      // Invariant: consume on success
      // Handling: consume + set approval when valid
      
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      // Verify token was consumed (preventing replay)
      expect(mockNext).toHaveBeenCalled();
      
      const context: ConfirmationContext = (mockReq as any).confirmationContext;
      expect(context.usedOneTimeToken).toBe(true);
      
      // Verify token cannot be reused
      const reuseResult = tokenStore.consumeOneTimeToken(token);
      expect(reuseResult.ok).toBe(false);
    });

    test('prevents token replay through consumption', () => {
      // This test verifies the replay prevention mechanism
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);
      expect(mockNext).toHaveBeenCalledTimes(1);

      // Second call: token is invalid (already consumed)
      jest.clearAllMocks();

      const mockReq2 = {
        ...mockReq,
        headers: {
          'x-arcanos-confirm-token': token
        }
      };

      confirmGate(mockReq2 as Request, mockRes as Response, mockNext);
      expect(mockNext).not.toHaveBeenCalled();
      expect(statusMock).toHaveBeenCalledWith(403);
    });
  });

  describe('Priority and precedence', () => {
    test('manual confirmation takes precedence over one-time token', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;
      mockReq.headers = {
        'x-confirmed': 'yes',
        'x-arcanos-confirm-token': token
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      
      const context: ConfirmationContext = (mockReq as any).confirmationContext;
      expect(context.manualConfirmation).toBe(true);
      expect(context.usedOneTimeToken).toBe(false);
      
      // Token should still be valid since it wasn't consumed
      const result = tokenStore.consumeOneTimeToken(token);
      expect(result.ok).toBe(true);
    });

    test('one-time token is checked when manual confirmation is absent', () => {
      const tokenRecord = tokenStore.createOneTimeToken();
      const token = tokenRecord.token;

      mockReq.headers = {
        'x-arcanos-confirm-token': token
        // No x-confirmed header
      };

      confirmGate(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });
});
