/**
 * Capability Gate Middleware Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { Request, Response, NextFunction } from 'express';

// Mock the agent registry
const mockValidateCapability = jest.fn();
jest.unstable_mockModule('../src/stores/agentRegistry.js', () => ({
  validateCapability: mockValidateCapability,
}));

const { capabilityGate } = await import('../src/middleware/capabilityGate.js');

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
});
