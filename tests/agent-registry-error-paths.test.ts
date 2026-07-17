import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockAgentCreate = jest.fn();
const mockAgentFindUnique = jest.fn();
const mockAgentFindMany = jest.fn();
const mockAgentUpdate = jest.fn();

const loggerErrorMock = jest.fn();
const loggerInfoMock = jest.fn();
const loggerWarnMock = jest.fn();

jest.unstable_mockModule('@prisma/client', () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    agent: {
      create: mockAgentCreate,
      findUnique: mockAgentFindUnique,
      findMany: mockAgentFindMany,
      update: mockAgentUpdate
    }
  }))
}));

jest.unstable_mockModule('@platform/logging/structuredLogging.js', () => ({
  aiLogger: {
    error: loggerErrorMock,
    info: loggerInfoMock,
    warn: loggerWarnMock
  }
}));

const agentRegistryModule = await import('../src/stores/agentRegistry.js');

describe('stores/agentRegistry error handling', () => {
  beforeEach(() => {
    mockAgentCreate.mockReset();
    mockAgentFindUnique.mockReset();
    mockAgentFindMany.mockReset();
    mockAgentUpdate.mockReset();
    loggerErrorMock.mockReset();
    loggerInfoMock.mockReset();
    loggerWarnMock.mockReset();
  });

  it('returns null and logs when heartbeat update fails', async () => {
    mockAgentUpdate.mockRejectedValueOnce(new Error('heartbeat update failed'));

    const result = await agentRegistryModule.updateHeartbeat('agent-err');

    expect(result).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to update heartbeat',
      expect.objectContaining({ module: 'agentRegistry', agentId: 'agent-err' })
    );
  });

  it('does not log raw dependency details when an agent lookup fails', async () => {
    const dependencyDetail = [
      ['Authorization', 'Bearer', ['phase2b', 'agent', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_agent_table'].join(' '),
      ['C:', 'private', 'agent-registry.log'].join('\\'),
    ].join(' | ');
    mockAgentFindUnique.mockRejectedValueOnce(new Error(dependencyDetail));

    const result = await agentRegistryModule.getAgent('phase2b-agent-read-failure');
    const observable = JSON.stringify(loggerWarnMock.mock.calls);

    expect(result).toBeNull();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Failed to fetch agent from DB; falling back to cache',
      {
        module: 'agentRegistry',
        agentId: 'phase2b-agent-read-failure',
        errorCode: 'AGENT_REGISTRY_READ_FAILED',
        errorClass: 'Error',
      },
    );
    expect(observable).not.toContain(dependencyDetail);
    expect(observable).not.toContain('private_agent_table');
    expect(observable).not.toContain('agent-registry.log');
  });

  it('returns null and logs when status update fails', async () => {
    mockAgentUpdate.mockRejectedValueOnce(new Error('status update failed'));

    const result = await agentRegistryModule.updateAgentStatus('agent-err', 'busy');

    expect(result).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to update agent status',
      expect.objectContaining({ module: 'agentRegistry', agentId: 'agent-err', status: 'busy' })
    );
  });

  it('returns null and logs when capability grant update fails', async () => {
    mockAgentFindUnique.mockResolvedValueOnce({
      id: 'agent-1',
      capabilities: ['existing']
    });
    mockAgentUpdate.mockRejectedValueOnce(new Error('grant failed'));

    const result = await agentRegistryModule.grantCapabilities('agent-1', ['new-cap']);

    expect(result).toBeNull();
    expect(loggerErrorMock).toHaveBeenCalledWith(
      'Failed to grant capabilities',
      expect.objectContaining({ module: 'agentRegistry', agentId: 'agent-1' })
    );
  });
});
