import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { RailwayProjectSummary } from '../src/services/railwayClient.js';

const workerHelperTokenA = 'worker-repair-token-a-123456789012';
const workerHelperTokenB = 'worker-repair-token-b-123456789012';
const workerHelperTokenHeaderName = 'x-arcanos-worker-helper-token';

const environment = new Map<string, string>();
const getEnvMock = jest.fn((name: string) => environment.get(name));
const getConfigMock = jest.fn(() => ({
  runWorkers: false,
  workerApiTimeoutMs: 5_000,
}));
const getStableWorkerRuntimeModeMock = jest.fn(() => ({
  requestedRunWorkers: false,
  resolvedRunWorkers: false,
  processKind: 'unknown',
  railwayServiceName: null,
  reason: 'requested',
}));
const isWorkerRuntimeSuppressedForServiceRoleMock = jest.fn(() => false);
const getRailwayApiConfigMock = jest.fn(() => ({
  endpoint: 'https://backboard.railway.com/graphql/v2',
}));
const deployServiceMock = jest.fn(async (_input?: unknown) => ({
  accepted: true,
  status: 'accepted',
}));
const isRailwayApiConfiguredMock = jest.fn(() => false);
const listProjectsMock = jest.fn(async (): Promise<RailwayProjectSummary[]> => []);
const healWorkerRuntimeMock = jest.fn(async () => ({
  timestamp: '2026-07-25T12:00:00.000Z',
  requestedForce: true,
  restart: {
    started: true,
    message: 'Local workers restarted.',
  },
  runtime: {
    enabled: true,
  },
}));

jest.unstable_mockModule('@platform/runtime/env.js', () => ({
  getEnv: getEnvMock,
}));

jest.unstable_mockModule('@platform/runtime/railway.js', () => ({
  getRailwayApiConfig: getRailwayApiConfigMock,
}));

jest.unstable_mockModule('@platform/runtime/unifiedConfig.js', () => ({
  getConfig: getConfigMock,
  getStableWorkerRuntimeMode: getStableWorkerRuntimeModeMock,
  isWorkerRuntimeSuppressedForServiceRole: isWorkerRuntimeSuppressedForServiceRoleMock,
}));

jest.unstable_mockModule('@services/railwayClient.js', () => ({
  deployService: deployServiceMock,
  isRailwayApiConfigured: isRailwayApiConfiguredMock,
  listProjects: listProjectsMock,
}));

jest.unstable_mockModule('@services/workerControlService.js', () => ({
  healWorkerRuntime: healWorkerRuntimeMock,
}));

jest.unstable_mockModule('@core/lib/errors/index.js', () => ({
  resolveErrorMessage: (error: unknown) => (
    error instanceof Error ? error.message : String(error)
  ),
}));

const {
  buildWorkerRepairActuatorStatus,
  executeWorkerRepairActuator,
} = await import('../src/services/selfImprove/workerRepairActuator.js');

function configureRemoteWorker(baseUrl = 'https://worker.example.test'): void {
  environment.set('SELF_HEAL_WORKER_SERVICE_URL', baseUrl);
}

function validRemoteApproval() {
  return {
    approved: true,
    approvedBy: 'operator:test',
    reason: 'Focused worker-repair actuator test',
    action: 'worker repair actuator remote_worker_helper',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
}

function validRailwayApproval() {
  return {
    ...validRemoteApproval(),
    action: 'worker repair actuator railway_service_deploy',
  };
}

function railwayPreviewProject(): RailwayProjectSummary {
  return {
    id: 'project-preview',
    name: 'Isolated acceptance project',
    environments: [
      {
        id: 'environment-production',
        name: 'production',
        services: [{ id: 'worker-production', name: 'ARCANOS Worker' }],
      },
      {
        id: 'environment-preview',
        name: 'pr-1539',
        services: [{ id: 'worker-preview', name: 'ARCANOS Worker' }],
      },
    ],
  };
}

function configureRailwayPreview(): void {
  isRailwayApiConfiguredMock.mockReturnValue(true);
  environment.set('RAILWAY_PROJECT_ID', 'project-preview');
  environment.set('RAILWAY_ENVIRONMENT_ID', 'environment-preview');
  environment.set('RAILWAY_ENVIRONMENT_NAME', 'pr-1539');
  listProjectsMock.mockResolvedValue([railwayPreviewProject()]);
}

function fetchReturning(responseFactory: () => Response) {
  return jest.fn(
    async (
      _input: string | URL | Request,
      _init?: RequestInit
    ): Promise<Response> => responseFactory()
  );
}

async function captureError(operation: Promise<unknown>): Promise<Error> {
  let observedError: unknown;
  try {
    await operation;
  } catch (error) {
    observedError = error;
  }

  expect(observedError).toBeInstanceOf(Error);
  return observedError as Error;
}

function serializeError(error: Error): string {
  return JSON.stringify({
    name: error.name,
    message: error.message,
    ...Object.fromEntries(Object.entries(error)),
  });
}

beforeEach(() => {
  environment.clear();
  jest.resetAllMocks();

  getEnvMock.mockImplementation((name: string) => environment.get(name));
  getConfigMock.mockReturnValue({
    runWorkers: false,
    workerApiTimeoutMs: 5_000,
  });
  getStableWorkerRuntimeModeMock.mockReturnValue({
    requestedRunWorkers: false,
    resolvedRunWorkers: false,
    processKind: 'unknown',
    railwayServiceName: null,
    reason: 'requested',
  });
  isWorkerRuntimeSuppressedForServiceRoleMock.mockReturnValue(false);
  getRailwayApiConfigMock.mockReturnValue({
    endpoint: 'https://backboard.railway.com/graphql/v2',
  });
  deployServiceMock.mockResolvedValue({
    accepted: true,
    status: 'accepted',
  });
  isRailwayApiConfiguredMock.mockReturnValue(false);
  listProjectsMock.mockResolvedValue([]);
  healWorkerRuntimeMock.mockResolvedValue({
    timestamp: '2026-07-25T12:00:00.000Z',
    requestedForce: true,
    restart: {
      started: true,
      message: 'Local workers restarted.',
    },
    runtime: {
      enabled: true,
    },
  });
});

describe('worker repair actuator Railway target containment', () => {
  it('redeploys only the exact approved preview project and environment', async () => {
    configureRailwayPreview();

    const result = await executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    });

    expect(deployServiceMock).toHaveBeenCalledTimes(1);
    expect(deployServiceMock).toHaveBeenCalledWith({
      environmentId: 'environment-preview',
      serviceId: 'worker-preview',
    });
    expect(result.payload).toEqual(expect.objectContaining({
      projectId: 'project-preview',
      environmentId: 'environment-preview',
      serviceId: 'worker-preview',
    }));
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('uses the exact runtime environment ID when no environment name is configured', async () => {
    configureRailwayPreview();
    environment.delete('RAILWAY_ENVIRONMENT_NAME');

    await executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    });

    expect(deployServiceMock).toHaveBeenCalledWith({
      environmentId: 'environment-preview',
      serviceId: 'worker-preview',
    });
  });

  it('preserves an exact explicit environment name when no runtime ID is available', async () => {
    configureRailwayPreview();
    environment.delete('RAILWAY_ENVIRONMENT_ID');
    environment.delete('RAILWAY_ENVIRONMENT_NAME');
    environment.set('SELF_HEAL_TARGET_ENVIRONMENT', 'PR-1539');

    await executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    });

    expect(deployServiceMock).toHaveBeenCalledWith({
      environmentId: 'environment-preview',
      serviceId: 'worker-preview',
    });
  });

  it.each([
    ['missing project scope', 'RAILWAY_PROJECT_ID', null],
    ['unmatched project scope', 'RAILWAY_PROJECT_ID', 'project-missing'],
    ['unmatched runtime environment ID', 'RAILWAY_ENVIRONMENT_ID', 'environment-missing'],
    ['environment name conflicting with runtime ID', 'RAILWAY_ENVIRONMENT_NAME', 'production'],
    ['override conflicting with the preview runtime', 'SELF_HEAL_TARGET_ENVIRONMENT', 'production'],
  ])('rejects %s without deploying either environment', async (_label, key, value) => {
    configureRailwayPreview();
    const onDispatch = jest.fn();
    if (value === null) {
      environment.delete(key);
    } else {
      environment.set(key, value);
    }

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    }, { onDispatch })).rejects.toThrow();

    expect(onDispatch).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
    expect(healWorkerRuntimeMock).not.toHaveBeenCalled();
  });

  it('rejects missing environment scope before inspecting Railway projects', async () => {
    configureRailwayPreview();
    const onDispatch = jest.fn();
    environment.delete('RAILWAY_ENVIRONMENT_ID');
    environment.delete('RAILWAY_ENVIRONMENT_NAME');

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    }, { onDispatch })).rejects.toThrow();

    expect(onDispatch).not.toHaveBeenCalled();
    expect(listProjectsMock).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });

  it('does not fall back to production when an explicit preview name is absent', async () => {
    configureRailwayPreview();
    const onDispatch = jest.fn();
    environment.delete('RAILWAY_ENVIRONMENT_ID');
    environment.set('RAILWAY_ENVIRONMENT_NAME', 'pr-1539-missing');

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    }, { onDispatch })).rejects.toThrow();

    expect(onDispatch).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });

  it('rejects a conflicting explicit override even without a runtime environment ID', async () => {
    configureRailwayPreview();
    const onDispatch = jest.fn();
    environment.delete('RAILWAY_ENVIRONMENT_ID');
    environment.set('SELF_HEAL_TARGET_ENVIRONMENT', 'production');

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    }, { onDispatch })).rejects.toThrow();

    expect(onDispatch).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });

  it.each(['project', 'environment', 'service'] as const)(
    'rejects an ambiguous %s match without deployment',
    async (duplicateKind) => {
      configureRailwayPreview();
      const onDispatch = jest.fn();
      const project = railwayPreviewProject();
      if (duplicateKind === 'project') {
        listProjectsMock.mockResolvedValue([project, { ...project }]);
      } else if (duplicateKind === 'environment') {
        project.environments.push({ ...project.environments[1] });
        listProjectsMock.mockResolvedValue([project]);
      } else {
        project.environments[1].services.push({
          id: 'worker-other',
          name: 'ARCANOS Worker',
        });
        listProjectsMock.mockResolvedValue([project]);
      }

      await expect(executeWorkerRepairActuator({
        source: 'isolated-acceptance-test',
        approval: validRailwayApproval(),
      }, { onDispatch })).rejects.toThrow();

      expect(onDispatch).not.toHaveBeenCalled();
      expect(deployServiceMock).not.toHaveBeenCalled();
    }
  );

  it('selects one explicit service ID among same-name preview services', async () => {
    configureRailwayPreview();
    const project = railwayPreviewProject();
    project.environments[1].services.push({
      id: 'worker-other',
      name: 'ARCANOS Worker',
    });
    listProjectsMock.mockResolvedValue([project]);
    environment.set('SELF_HEAL_WORKER_SERVICE_ID', 'worker-preview');

    await executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    });

    expect(deployServiceMock).toHaveBeenCalledWith({
      environmentId: 'environment-preview',
      serviceId: 'worker-preview',
    });
  });

  it.each([
    undefined,
    { ...validRailwayApproval(), approved: false },
    { ...validRailwayApproval(), action: 'worker repair actuator remote_worker_helper' },
    { ...validRailwayApproval(), expiresAt: '2000-01-01T00:00:00.000Z' },
  ])('requires current action-specific operator approval before target discovery', async (approval) => {
    configureRailwayPreview();
    const onDispatch = jest.fn();

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval,
    }, { onDispatch })).rejects.toThrow(/requires explicit operator approval/u);

    expect(onDispatch).not.toHaveBeenCalled();
    expect(listProjectsMock).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });

  it('keeps web-role repair disabled even with exact scope and approval', async () => {
    configureRailwayPreview();
    const onDispatch = jest.fn();
    isWorkerRuntimeSuppressedForServiceRoleMock.mockReturnValue(true);

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
      approval: validRailwayApproval(),
    }, { onDispatch })).rejects.toThrow(/disabled in the web service role/u);

    expect(onDispatch).not.toHaveBeenCalled();
    expect(listProjectsMock).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });

  it('preserves local repair without Railway scope or privileged approval', async () => {
    getConfigMock.mockReturnValue({ runWorkers: true, workerApiTimeoutMs: 5_000 });

    await expect(executeWorkerRepairActuator({
      source: 'isolated-acceptance-test',
    })).resolves.toEqual(expect.objectContaining({ mode: 'local_in_process' }));

    expect(healWorkerRuntimeMock).toHaveBeenCalledWith(true, 'isolated-acceptance-test');
    expect(listProjectsMock).not.toHaveBeenCalled();
    expect(deployServiceMock).not.toHaveBeenCalled();
  });
});

describe('worker repair actuator dispatch boundary', () => {
  it.each(['local', 'railway', 'remote'] as const)(
    'records one dispatch before an approved %s repair completes',
    async (mode) => {
      const onDispatch = jest.fn();
      const fetchMock = fetchReturning(() => new Response(JSON.stringify({
        requestedForce: true,
        restart: {
          started: true,
          alreadyRunning: false,
          runWorkers: true,
          message: 'Synthetic worker restart.',
        },
      }), { headers: { 'content-type': 'application/json' } }));
      if (mode === 'local') {
        getConfigMock.mockReturnValue({ runWorkers: true, workerApiTimeoutMs: 5_000 });
      } else if (mode === 'railway') {
        configureRailwayPreview();
      } else {
        configureRemoteWorker();
      }

      await executeWorkerRepairActuator({
        source: 'isolated-acceptance-test',
        approval: mode === 'railway' ? validRailwayApproval() : validRemoteApproval(),
      }, {
        onDispatch,
        resolveWorkerHelperToken: () => workerHelperTokenA,
        fetchFn: fetchMock as unknown as typeof fetch,
      });

      const operation = mode === 'local'
        ? healWorkerRuntimeMock
        : mode === 'railway' ? deployServiceMock : fetchMock;
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(onDispatch.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
    }
  );

  it.each(['local', 'railway', 'remote'] as const)(
    'records one dispatch when an approved %s operation throws',
    async (mode) => {
      const onDispatch = jest.fn();
      const fetchMock = jest.fn(async (): Promise<Response> => {
        throw new Error('Synthetic worker transport failure.');
      });
      if (mode === 'local') {
        getConfigMock.mockReturnValue({ runWorkers: true, workerApiTimeoutMs: 5_000 });
        healWorkerRuntimeMock.mockRejectedValueOnce(new Error('Synthetic local repair failure.'));
      } else if (mode === 'railway') {
        configureRailwayPreview();
        deployServiceMock.mockRejectedValueOnce(new Error('Synthetic Railway repair failure.'));
      } else {
        configureRemoteWorker();
      }

      await expect(executeWorkerRepairActuator({
        source: 'isolated-acceptance-test',
        approval: mode === 'railway' ? validRailwayApproval() : validRemoteApproval(),
      }, {
        onDispatch,
        resolveWorkerHelperToken: () => workerHelperTokenA,
        fetchFn: fetchMock as unknown as typeof fetch,
      })).rejects.toThrow();

      const operation = mode === 'local'
        ? healWorkerRuntimeMock
        : mode === 'railway' ? deployServiceMock : fetchMock;
      expect(onDispatch).toHaveBeenCalledTimes(1);
      expect(operation).toHaveBeenCalledTimes(1);
      expect(onDispatch.mock.invocationCallOrder[0]).toBeLessThan(operation.mock.invocationCallOrder[0]);
    }
  );
});

describe('worker repair actuator remote credential boundary', () => {
  it.each([
    null,
    '',
  ])('does not advertise remote repair without an injected credential: %p', (credential) => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => credential,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it.each([
    'too-short',
    ` ${workerHelperTokenA}`,
    'worker-repair-token-with-space-1234 5678',
    'change-me-worker-repair-token-1234567890',
    'x'.repeat(4_097),
  ])('does not advertise remote repair for an invalid injected credential', (credential) => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => credential,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('does not advertise remote repair when the credential collides with another purpose', () => {
    configureRemoteWorker();
    environment.set('ARCANOS_GPT_ACCESS_TOKEN', ` ${workerHelperTokenA} `);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('advertises a valid remote repair without exposing the credential in status', () => {
    configureRemoteWorker();

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'remote_worker_helper',
      available: true,
      baseUrl: 'https://worker.example.test',
      path: '/worker-helper/heal',
    }));
    expect(JSON.stringify(status)).not.toContain(workerHelperTokenA);
  });

  it.each([
    {
      label: 'an exact HTTPS origin',
      baseUrl: 'https://worker.example.test',
      available: true,
      normalizedBaseUrl: 'https://worker.example.test',
    },
    {
      label: 'an explicit IPv4 loopback HTTP origin',
      baseUrl: 'http://127.0.0.1:3030',
      available: true,
      normalizedBaseUrl: 'http://127.0.0.1:3030',
    },
    {
      label: 'an explicit localhost HTTP origin',
      baseUrl: 'http://localhost:3030',
      available: true,
      normalizedBaseUrl: 'http://localhost:3030',
    },
    {
      label: 'a remote plaintext HTTP origin',
      baseUrl: 'http://worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'a hostname with an implicit scheme',
      baseUrl: 'worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with a path',
      baseUrl: 'https://worker.example.test/internal',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with credentials',
      baseUrl: 'https://user:password@worker.example.test',
      available: false,
      normalizedBaseUrl: null,
    },
    {
      label: 'an HTTPS URL with a query string',
      baseUrl: 'https://worker.example.test?target=other',
      available: false,
      normalizedBaseUrl: null,
    },
  ])('requires $label', ({ baseUrl, available, normalizedBaseUrl }) => {
    configureRemoteWorker(baseUrl);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status.available).toBe(available);
    expect(status.mode).toBe(available ? 'remote_worker_helper' : 'unavailable');
    expect(status.baseUrl).toBe(normalizedBaseUrl);
  });

  it('fails closed when worker-helper URL aliases conflict', () => {
    environment.set('SELF_HEAL_WORKER_SERVICE_URL', 'https://worker-a.example.test');
    environment.set('WORKER_HELPER_BASE_URL', 'https://worker-b.example.test');

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken: () => workerHelperTokenA,
    });

    expect(status).toEqual(expect.objectContaining({
      mode: 'unavailable',
      available: false,
      baseUrl: null,
      path: null,
    }));
  });

  it('does not resolve a remote credential while local repair is selected', () => {
    configureRemoteWorker();
    getConfigMock.mockReturnValue({
      runWorkers: true,
      workerApiTimeoutMs: 5_000,
    });
    const resolveWorkerHelperToken = jest.fn(() => workerHelperTokenA);

    const status = buildWorkerRepairActuatorStatus({
      resolveWorkerHelperToken,
    });

    expect(status.mode).toBe('local_in_process');
    expect(status.available).toBe(true);
    expect(resolveWorkerHelperToken).not.toHaveBeenCalled();
  });

  it('does not fetch when operator approval is absent', async () => {
    configureRemoteWorker();
    const onDispatch = jest.fn();
    const resolveWorkerHelperToken = jest.fn(() => workerHelperTokenA);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
    }, {
      onDispatch,
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/requires explicit operator approval/i);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenA);
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when no credential is available during status resolution', async () => {
    configureRemoteWorker();
    const onDispatch = jest.fn();
    const resolveWorkerHelperToken = jest.fn((): string | null => null);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      onDispatch,
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/configuration is incomplete/i);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when the credential disappears before execution', async () => {
    configureRemoteWorker();
    const onDispatch = jest.fn();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(null);
    const fetchMock = fetchReturning(() => new Response('{}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      onDispatch,
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toMatch(/configuration is incomplete/i);
    expect(onDispatch).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenA);
    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('re-resolves a rotated credential, uses only the custom carrier, and drops remote-controlled result text', async () => {
    configureRemoteWorker();
    const untrustedRemoteMessage = 'REMOTE-UNTRUSTED-MESSAGE';
    const unrelatedSecret = 'unrelated-secret-that-must-not-propagate';
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const reflectedCredentialKey = `debug-${workerHelperTokenB}`;
    const fetchMock = fetchReturning(() => new Response(JSON.stringify({
      timestamp: '2026-07-25T12:00:00.000Z',
      requestedForce: true,
      restart: {
        started: true,
        alreadyRunning: false,
        runWorkers: true,
        workerCount: 2,
        message: `${untrustedRemoteMessage} ${workerHelperTokenB} ${unrelatedSecret}`,
        untrustedDetail: 'REMOTE-UNTRUSTED-RESTART-DETAIL',
      },
      runtime: {
        enabled: true,
        configuredCount: 2,
        activeListeners: 2,
        lastError: `reflected ${workerHelperTokenB}`,
      },
      message: `outer message ${workerHelperTokenB}`,
      untrustedDetail: 'REMOTE-UNTRUSTED-TOP-LEVEL-DETAIL',
      [reflectedCredentialKey]: 'reflected credential key',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    }));

    const result = await executeWorkerRepairActuator({
      force: true,
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    });

    expect(resolveWorkerHelperToken).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [requestUrl, requestOptions] = fetchMock.mock.calls[0]!;
    const requestHeaders = new Headers(requestOptions?.headers);
    expect(String(requestUrl)).toBe('https://worker.example.test/worker-helper/heal');
    expect(requestOptions).toEqual(expect.objectContaining({
      method: 'POST',
      redirect: 'error',
      body: JSON.stringify({
        mode: 'execute',
        execute: true,
        force: true,
      }),
      signal: expect.any(AbortSignal),
    }));
    expect(requestHeaders.get(workerHelperTokenHeaderName)).toBe(workerHelperTokenB);
    expect(requestHeaders.get('authorization')).toBeNull();
    expect(requestHeaders.get('content-type')).toBe('application/json');
    expect(JSON.stringify(requestOptions?.headers)).not.toContain(workerHelperTokenA);

    expect(result).toEqual({
      mode: 'remote_worker_helper',
      baseUrl: 'https://worker.example.test',
      path: '/worker-helper/heal',
      statusCode: 200,
      message: 'Remote worker runtime restart started.',
      payload: {
        requestedForce: true,
        restart: {
          started: true,
          alreadyRunning: false,
          runWorkers: true,
          message: 'Remote worker runtime restart started.',
        },
      },
    });
    expect(result.payload).not.toHaveProperty('untrustedDetail');
    expect(result.payload.restart).not.toEqual(expect.objectContaining({
      untrustedDetail: expect.anything(),
    }));
    expect(JSON.stringify(result)).not.toContain(workerHelperTokenA);
    expect(JSON.stringify(result)).not.toContain(workerHelperTokenB);
    expect(JSON.stringify(result)).not.toContain(reflectedCredentialKey);
    expect(JSON.stringify(result)).not.toContain(untrustedRemoteMessage);
    expect(JSON.stringify(result)).not.toContain(unrelatedSecret);
  });

  it('keeps the actuator timeout active while reading the remote body', async () => {
    configureRemoteWorker();
    jest.useFakeTimers();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    let observedSignal: AbortSignal | undefined;
    const fetchMock = jest.fn(async (
      _input: string | URL | Request,
      requestOptions?: RequestInit
    ): Promise<Response> => {
      observedSignal = requestOptions?.signal as AbortSignal;
      return new Response(new ReadableStream({
        start(controller) {
          observedSignal?.addEventListener('abort', () => {
            controller.error(new Error(`body reflected ${workerHelperTokenB}`));
          }, { once: true });
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    try {
      const errorPromise = captureError(executeWorkerRepairActuator({
        source: 'focused-test',
        approval: validRemoteApproval(),
      }, {
        resolveWorkerHelperToken,
        fetchFn: fetchMock as unknown as typeof fetch,
      }));

      await jest.advanceTimersByTimeAsync(5_000);
      const error = await errorPromise;

      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal?.aborted).toBe(true);
      expect(error.message).toBe(
        'Worker repair actuator failed: Remote worker-helper response was invalid.'
      );
      expect(serializeError(error)).not.toContain(workerHelperTokenA);
      expect(serializeError(error)).not.toContain(workerHelperTokenB);
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    {
      label: 'redirect',
      status: 302,
      expectedMessage: 'Remote worker repair redirect response was rejected.',
    },
    {
      label: 'non-success',
      status: 502,
      expectedMessage: 'Remote worker repair failed with HTTP 502.',
    },
  ])('cancels $label bodies without reading them', async ({
    status,
    expectedMessage,
  }) => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const cancel = jest.fn(async () => undefined);
    const text = jest.fn(async () => `untrusted ${workerHelperTokenB}`);
    const response = {
      ok: false,
      status,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: { cancel },
      text,
    } as unknown as Response;
    const fetchMock = jest.fn(async (): Promise<Response> => response);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(`Worker repair actuator failed: ${expectedMessage}`);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(text).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenB);
  });

  it('cancels a streamed remote response once it exceeds 64 KiB', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const cancel = jest.fn();
    const oversizedStream = new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(40_000));
      },
      cancel,
    });
    const fetchMock = fetchReturning(() => new Response(oversizedStream, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(
      'Worker repair actuator failed: Remote worker-helper response was invalid.'
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-stream success response without invoking an unbounded text fallback', async () => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const text = jest.fn(async () => JSON.stringify({
      reflected: workerHelperTokenB,
    }));
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text,
    } as unknown as Response;
    const fetchMock = jest.fn(async (): Promise<Response> => response);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));

    expect(error.message).toBe(
      'Worker repair actuator failed: Remote worker-helper response was invalid.'
    );
    expect(text).not.toHaveBeenCalled();
    expect(serializeError(error)).not.toContain(workerHelperTokenB);
  });

  it.each([
    {
      label: 'a non-success response',
      sensitiveMarker: 'REMOTE-NON-2XX-SENSITIVE-BODY',
      responseFactory: () => new Response(JSON.stringify({
        error: `REMOTE-NON-2XX-SENSITIVE-BODY ${workerHelperTokenB}`,
      }), {
        status: 502,
        headers: { 'content-type': 'application/json' },
      }),
    },
    {
      label: 'a non-JSON success response',
      sensitiveMarker: 'REMOTE-NON-JSON-SENSITIVE-BODY',
      responseFactory: () => new Response(
        `REMOTE-NON-JSON-SENSITIVE-BODY ${workerHelperTokenB}`,
        {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }
      ),
    },
    {
      label: 'an oversized success response',
      sensitiveMarker: 'REMOTE-OVERSIZED-SENSITIVE-BODY',
      responseFactory: () => {
        const body = JSON.stringify({
          message: `REMOTE-OVERSIZED-SENSITIVE-BODY ${workerHelperTokenB}`,
          padding: 'x'.repeat(1024 * 1024),
        });
        return new Response(body, {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(body, 'utf8')),
          },
        });
      },
    },
  ])('returns a generic error for $label', async ({
    sensitiveMarker,
    responseFactory,
  }) => {
    configureRemoteWorker();
    const resolveWorkerHelperToken = jest.fn((): string | null => workerHelperTokenA);
    resolveWorkerHelperToken
      .mockReturnValueOnce(workerHelperTokenA)
      .mockReturnValueOnce(workerHelperTokenB);
    const fetchMock = fetchReturning(responseFactory);

    const error = await captureError(executeWorkerRepairActuator({
      source: 'focused-test',
      approval: validRemoteApproval(),
    }, {
      resolveWorkerHelperToken,
      fetchFn: fetchMock as unknown as typeof fetch,
    }));
    const serializedError = serializeError(error);

    expect(error.message).toMatch(/^Worker repair actuator failed:/u);
    expect(error.message.length).toBeLessThan(256);
    expect(serializedError).not.toContain(sensitiveMarker);
    expect(serializedError).not.toContain(workerHelperTokenA);
    expect(serializedError).not.toContain(workerHelperTokenB);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
