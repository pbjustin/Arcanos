import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockAgentCreate = jest.fn();
const mockAgentFindUnique = jest.fn();
const mockAgentFindMany = jest.fn();
const mockAgentUpdate = jest.fn();
const mockTransaction = jest.fn();

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
    },
    $transaction: mockTransaction,
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
    mockTransaction.mockReset();
    mockTransaction.mockImplementation(async (
      callback: (transaction: {
        agent: {
          findUnique: typeof mockAgentFindUnique;
          update: typeof mockAgentUpdate;
        };
      }) => unknown,
    ) => callback({
      agent: {
        findUnique: mockAgentFindUnique,
        update: mockAgentUpdate,
      },
    }));
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

  it('does not log registered capability values', async () => {
    const capability = ['phase2e', 'registered', 'marker'].join('.');
    const agent = {
      id: 'agent-register-safe-log',
      role: 'executor',
      capabilities: [capability],
      publicKey: null,
      status: 'idle',
      lastHeartbeat: new Date(0),
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    mockAgentCreate.mockResolvedValueOnce(agent);

    await expect(agentRegistryModule.registerAgent({
      role: 'executor',
      capabilities: [capability],
    })).resolves.toEqual(agent);

    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain(capability);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Agent registered',
      expect.objectContaining({ capabilityCount: 1 }),
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

  it('does not return a cached agent when an authoritative read fails', async () => {
    const cachedAgent = {
      id: 'phase2e-authoritative-agent',
      role: 'executor',
      capabilities: ['terminal.run'],
      publicKey: null,
      status: 'idle',
      lastHeartbeat: null,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    };
    mockAgentFindUnique.mockResolvedValueOnce(cachedAgent);
    await expect(agentRegistryModule.getAgent(cachedAgent.id)).resolves.toEqual(cachedAgent);

    const dependencyDetail = [
      ['Authorization', 'Bearer', ['phase2e', 'cached', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_agent_table'].join(' '),
      ['C:', 'private', 'authoritative-read.log'].join('\\'),
    ].join(' | ');
    mockAgentFindUnique.mockRejectedValueOnce(new Error(dependencyDetail));

    await expect(agentRegistryModule.getAuthoritativeAgent(cachedAgent.id))
      .rejects.toThrow(dependencyDetail);

    const observable = JSON.stringify({
      errors: loggerErrorMock.mock.calls,
      warnings: loggerWarnMock.mock.calls,
    });
    expect(observable).not.toContain(dependencyDetail);
    expect(observable).not.toContain('private_agent_table');
    expect(observable).not.toContain('authoritative-read.log');
    expect(mockAgentFindUnique).toHaveBeenLastCalledWith({ where: { id: cachedAgent.id } });
  });

  it('does not return cached agents when an authoritative list fails', async () => {
    const dependencyDetail = [
      ['Authorization', 'Bearer', ['phase2e', 'list', 'marker'].join('-')].join(' '),
      ['SELECT', '*', 'FROM', 'private_agent_table'].join(' '),
      ['C:', 'private', 'authoritative-list.log'].join('\\'),
    ].join(' | ');
    mockAgentFindMany.mockRejectedValueOnce(new Error(dependencyDetail));

    await expect(agentRegistryModule.listAuthoritativeAgents()).rejects.toThrow(dependencyDetail);

    const observable = JSON.stringify({
      errors: loggerErrorMock.mock.calls,
      warnings: loggerWarnMock.mock.calls,
    });
    expect(observable).not.toContain(dependencyDetail);
    expect(observable).not.toContain('private_agent_table');
    expect(observable).not.toContain('authoritative-list.log');
    expect(mockAgentFindMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('grants capabilities through a serializable authoritative transaction without logging values', async () => {
    const capability = ['phase2e', 'capability', 'marker'].join('.');
    const current = {
      id: 'agent-authoritative-grant',
      capabilities: ['terminal.run'],
    };
    const updated = {
      ...current,
      capabilities: [capability, 'terminal.run'],
    };
    mockAgentFindUnique.mockResolvedValueOnce(current);
    mockAgentUpdate.mockResolvedValueOnce(updated);

    await expect(agentRegistryModule.grantAuthoritativeCapabilities(current.id, [capability]))
      .resolves.toEqual(updated);

    expect(mockTransaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'Serializable',
    });
    expect(mockAgentFindUnique).toHaveBeenCalledWith({ where: { id: current.id } });
    expect(mockAgentUpdate).toHaveBeenCalledWith({
      where: { id: current.id },
      data: { capabilities: [capability, 'terminal.run'] },
    });
    expect(JSON.stringify(loggerInfoMock.mock.calls)).not.toContain(capability);
    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Authoritative capabilities granted',
      expect.objectContaining({ capabilityCount: 1 }),
    );
  });

  it('rejects an authoritative capability write failure without logging dependency details', async () => {
    const dependencyDetail = [
      ['Authorization', 'Bearer', ['phase2e', 'grant', 'marker'].join('-')].join(' '),
      ['UPDATE', 'private_agent_table'].join(' '),
      ['C:', 'private', 'authoritative-grant.log'].join('\\'),
    ].join(' | ');
    mockAgentFindUnique.mockRejectedValueOnce(new Error(dependencyDetail));

    await expect(agentRegistryModule.grantAuthoritativeCapabilities('agent-grant-failure', ['terminal.run']))
      .rejects.toThrow(dependencyDetail);

    const observable = JSON.stringify({
      errors: loggerErrorMock.mock.calls,
      warnings: loggerWarnMock.mock.calls,
      info: loggerInfoMock.mock.calls,
    });
    expect(observable).not.toContain(dependencyDetail);
    expect(observable).not.toContain('private_agent_table');
    expect(observable).not.toContain('authoritative-grant.log');
  });
});
