/**
 * Capability Gate Middleware Tests
 */

import { afterEach, describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

// Mock the agent registry
const mockValidateCapability = jest.fn();
jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: mockValidateCapability,
}));

const { capabilityGate } = await import('../src/middleware/capabilityGate.js');

const originalAutomationSecret = process.env.ARCANOS_AUTOMATION_SECRET;
const originalAutomationHeader = process.env.ARCANOS_AUTOMATION_HEADER;

describe('capabilityGate middleware', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    jsonMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    mockReq = { body: {}, headers: {} };
    mockRes = { status: statusMock, json: jsonMock };
    mockNext = jest.fn();
  });

  afterEach(() => {
    if (originalAutomationSecret === undefined) {
      delete process.env.ARCANOS_AUTOMATION_SECRET;
    } else {
      process.env.ARCANOS_AUTOMATION_SECRET = originalAutomationSecret;
    }
    if (originalAutomationHeader === undefined) {
      delete process.env.ARCANOS_AUTOMATION_HEADER;
    } else {
      process.env.ARCANOS_AUTOMATION_HEADER = originalAutomationHeader;
    }
  });

  it('should reject requests without agent identity', async () => {
    const middleware = capabilityGate('terminal.run');
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should reject agents without required capability', async () => {
    mockReq.body = { agent_id: 'agent-1', capability: 'terminal.run' };
    mockValidateCapability.mockResolvedValue(false);

    const middleware = capabilityGate('terminal.run');
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(statusMock).toHaveBeenCalledWith(403);
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('should allow agents with required capability', async () => {
    mockReq.body = { agent_id: 'agent-1', capability: 'terminal.run' };
    mockValidateCapability.mockResolvedValue(true);

    const middleware = capabilityGate('terminal.run');
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
  });

  it('should accept agent identity from x-agent-id header', async () => {
    mockReq.headers = { 'x-agent-id': 'agent-2' };
    mockReq.body = { capability: 'vision.analyze' };
    mockValidateCapability.mockResolvedValue(true);

    const middleware = capabilityGate('vision.analyze');
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockValidateCapability).toHaveBeenCalledWith('agent-2', 'vision.analyze');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should pass through when no capability is required', async () => {
    mockReq.body = { agent_id: 'agent-1' };

    const middleware = capabilityGate();
    await middleware(mockReq as Request, mockRes as Response, mockNext);

    expect(mockNext).toHaveBeenCalled();
    expect(mockValidateCapability).not.toHaveBeenCalled();
  });

  it('keeps automation extraction separate from exact opaque credential equality', async () => {
    const credential = ['phase2a', 'capability', 'sécurité'].join('-');
    const wrongCredential = `${credential.slice(0, -1)}x`;
    process.env.ARCANOS_AUTOMATION_SECRET = `  ${credential}  `;
    process.env.ARCANOS_AUTOMATION_HEADER = 'x-phase2a-automation';
    const middleware = capabilityGate('terminal.run');

    mockReq = {
      body: { capability: 'terminal.run' },
      headers: { 'x-phase2a-automation': wrongCredential },
      path: '/phase2a/capability',
    };
    await middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(401);
    expect(mockNext).not.toHaveBeenCalled();

    jest.clearAllMocks();
    mockReq.headers = { 'x-phase2a-automation': credential };
    await middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(mockNext).toHaveBeenCalledTimes(1);
    expect(mockValidateCapability).not.toHaveBeenCalled();
  });
});
