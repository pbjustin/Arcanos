import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R1_APPROVED_REDIS_START_COMMAND,
  GATE_R1_APPROVED_SERVICES,
  GATE_R1_ENVIRONMENT_METADATA_QUERY,
  GATE_R1_METADATA_ENVIRONMENT_ID,
  GATE_R1_METADATA_ENDPOINT,
  GATE_R1_METADATA_PROJECT_ID,
  GATE_R1_METADATA_RESPONSE_LIMIT_BYTES,
  GATE_R1_METADATA_TOKEN_ENV,
  GATE_R1_PRIVATE_ENDPOINT_QUERY,
  GATE_R1_REPLACEMENT_NAMES,
  parseGateR1MetadataArgs,
  projectGateR1EnvironmentMetadata,
  projectGateR1PrivateEndpoint,
  runGateR1MetadataCli
} from '../scripts/gate-r1-railway-metadata-projector.js';

const FIXTURE_PROJECT_ACCESS_VALUE = 'fixture-project-access-value';
const NETWORK_ID = '11111111-2222-4333-8444-555555555555';
const SERVICE_INSTANCE_ID = '22222222-3333-4444-8555-666666666666';
const DEPLOYMENT_ID = '33333333-4444-4555-8666-777777777777';
const VOLUME_INSTANCE_ID = '44444444-5555-4666-8777-888888888888';
const VOLUME_ID = '55555555-6666-4777-8888-999999999999';
const VARIABLE_ID = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const ENDPOINT_ID = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
const REPLACEMENT_SERVICE_ID = '88888888-9999-4aaa-8bbb-cccccccccccc';
const OBSERVED_AT = '2026-07-19T12:34:56.789Z';

function env() { return { [GATE_R1_METADATA_TOKEN_ENV]: FIXTURE_PROJECT_ACCESS_VALUE }; }
function connection(nodes) { return { pageInfo: { hasNextPage: false }, edges: nodes.map((node) => ({ node })) }; }
function service({
  serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0],
  serviceName = GATE_R1_APPROVED_SERVICES[serviceId],
  id = SERVICE_INSTANCE_ID,
  source = null,
  deployment = null,
  domains = { serviceDomains: [], customDomains: [] }
} = {}) {
  return {
    id, serviceId, serviceName,
    environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
    deletedAt: null,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    startCommand: null,
    source,
    latestDeployment: deployment,
    activeDeployments: deployment ? [deployment] : [],
    domains
  };
}
function payload({ services, volumes, variables, networks, extraData } = {}) {
  const selectedServices = services ?? [service()];
  return {
    data: {
      projectToken: { projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID },
      project: {
        id: GATE_R1_METADATA_PROJECT_ID,
        name: 'Arcanos',
        services: connection(selectedServices.map(({ serviceId, serviceName }) => ({ id: serviceId, name: serviceName })))
      },
      environment: {
        id: GATE_R1_METADATA_ENVIRONMENT_ID,
        name: 'phase2e-validation-20260717',
        projectId: GATE_R1_METADATA_PROJECT_ID,
        serviceInstances: connection(selectedServices),
        volumeInstances: connection(volumes ?? []),
        variables: connection(variables ?? [])
      },
      privateNetworks: networks ?? [{
        publicId: NETWORK_ID,
        projectId: GATE_R1_METADATA_PROJECT_ID,
        environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
        deletedAt: null
      }],
      ...extraData
    }
  };
}
function response(value, init = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) }
  });
}
function fetchFor(value = payload()) { return jest.fn(async () => response(value)); }

describe('Gate R1 schema-locked Railway metadata projector', () => {
  it('uses fixed read-only queries that cannot request config, variable values, domains, or introspection', () => {
    for (const query of [GATE_R1_ENVIRONMENT_METADATA_QUERY, GATE_R1_PRIVATE_ENDPOINT_QUERY]) {
      expect(query).toMatch(/^query GateR1/);
      expect(query).not.toMatch(/\bmutation\b|__schema|__type|decryptVariables|environmentVariables|environmentConfig|\bconfig\b/i);
    }
    expect(GATE_R1_ENVIRONMENT_METADATA_QUERY).toContain('variables(first: 100)');
    expect(GATE_R1_ENVIRONMENT_METADATA_QUERY).toContain('services(first: 100)');
    expect(GATE_R1_ENVIRONMENT_METADATA_QUERY).toContain('node { id name serviceId environmentId isSealed }');
    expect(GATE_R1_ENVIRONMENT_METADATA_QUERY).not.toMatch(/variableValue|value\s*[}\n]/i);
    expect(GATE_R1_ENVIRONMENT_METADATA_QUERY).not.toMatch(/domain\s|hostname|fqdn|port/i);
  });

  it('projects exact allowlisted topology, deployment, volume, domain counts, and variable names', async () => {
    const serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0];
    const deployment = { id: DEPLOYMENT_ID, status: 'SUCCESS', createdAt: '2026-07-19T10:00:00.000Z' };
    const fetchImpl = fetchFor(payload({
      services: [service({
        serviceId,
        serviceName: GATE_R1_APPROVED_SERVICES[serviceId],
        source: { image: 'ghcr.io/railwayapp-templates/postgres-ssl:18.4', repo: null },
        deployment,
        domains: { serviceDomains: [], customDomains: [] }
      })],
      volumes: [{
        id: VOLUME_INSTANCE_ID, serviceId, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
        mountPath: '/var/lib/postgresql/data', state: 'READY',
        volume: { id: VOLUME_ID, name: 'postgres-volume', projectId: GATE_R1_METADATA_PROJECT_ID }
      }],
      variables: [{
        id: VARIABLE_ID, name: 'POSTGRES_PASSWORD', serviceId,
        environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, isSealed: true
      }]
    }));

    const result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl, clock: () => OBSERVED_AT });

    expect(result).toEqual({
      schemaVersion: 1,
      observedAt: OBSERVED_AT,
      projectId: GATE_R1_METADATA_PROJECT_ID,
      projectName: 'Arcanos',
      environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
      environmentName: 'phase2e-validation-20260717',
      privateNetworkId: NETWORK_ID,
      projectServices: [{ serviceId, serviceName: 'Postgres' }],
      services: [{
        serviceId,
        serviceInstanceId: SERVICE_INSTANCE_ID,
        serviceName: 'Postgres',
        deleted: false,
        sourceKind: 'IMAGE',
        sourceImage: 'ghcr.io/railwayapp-templates/postgres-ssl:18.4',
        sourceImageApproved: true,
        repositoryConfigured: false,
        latestDeployment: deployment,
        activeDeployments: [deployment],
        restartPolicyType: 'ON_FAILURE',
        restartPolicyMaxRetries: 3,
        startCommandContract: 'NOT_APPLICABLE',
        railwayDomainCount: 0,
        customDomainCount: 0
      }],
      volumes: [{
        volumeInstanceId: VOLUME_INSTANCE_ID,
        volumeId: VOLUME_ID,
        volumeName: 'postgres-volume',
        serviceId,
        mountPath: '/var/lib/postgresql/data',
        state: 'READY'
      }],
      variablesByService: { [serviceId]: [{ name: 'POSTGRES_PASSWORD', sealed: true }] },
      sharedVariableNames: []
    });
    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe(GATE_R1_METADATA_ENDPOINT);
    expect(init.headers['Project-Access-Token']).toBe(FIXTURE_PROJECT_ACCESS_VALUE);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(JSON.parse(init.body)).toEqual({
      query: GATE_R1_ENVIRONMENT_METADATA_QUERY,
      variables: { projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID }
    });
    expect(init.body).not.toContain(FIXTURE_PROJECT_ACCESS_VALUE);
  });

  it('accepts a dynamically identified replacement only under an exact approved replacement name', async () => {
    const result = await projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ services: [service({
        serviceId: REPLACEMENT_SERVICE_ID,
        serviceName: GATE_R1_REPLACEMENT_NAMES[0]
      })] }))
    });
    expect(result.services[0]).toMatchObject({ serviceId: REPLACEMENT_SERVICE_ID, serviceName: GATE_R1_REPLACEMENT_NAMES[0] });

    await expect(projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ services: [service({
        serviceId: REPLACEMENT_SERVICE_ID,
        serviceName: 'ARCANOS V2'
      })] }))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('projects the full bounded project service list so replacement-name absence is provable', async () => {
    const value = payload();
    value.data.project.services = connection([
      { id: Object.keys(GATE_R1_APPROVED_SERVICES)[0], name: 'Postgres' },
      { id: REPLACEMENT_SERVICE_ID, name: GATE_R1_REPLACEMENT_NAMES[0] }
    ]);
    const result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(value) });
    expect(result.projectServices).toEqual([
      { serviceId: REPLACEMENT_SERVICE_ID, serviceName: GATE_R1_REPLACEMENT_NAMES[0] },
      { serviceId: Object.keys(GATE_R1_APPROVED_SERVICES)[0], serviceName: 'Postgres' }
    ]);

    value.data.project.services.pageInfo.hasNextPage = true;
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(value) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('requires every environment service ID and name to exist in project services', async () => {
    const missing = payload();
    missing.data.project.services = connection([]);
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(missing) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');

    const renamed = payload();
    renamed.data.project.services.edges[0].node.name = 'different-project-name';
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(renamed) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('accepts names-only shared variables and emits their sorted names without values', async () => {
    const value = payload({ variables: [
      { id: VARIABLE_ID, name: 'Z_SHARED', serviceId: null, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, isSealed: true },
      { id: ENDPOINT_ID, name: 'A_SHARED', serviceId: null, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, isSealed: false }
    ] });
    const result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(value) });
    expect(result.sharedVariableNames).toEqual(['A_SHARED', 'Z_SHARED']);
    expect(JSON.stringify(result)).not.toMatch(/credential-sentinel|variableValue/);
  });

  it('validates and projects volume state and project ownership', async () => {
    const serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0];
    const volume = {
      id: VOLUME_INSTANCE_ID, serviceId, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
      mountPath: '/var/lib/postgresql/data', state: 'MIGRATING',
      volume: { id: VOLUME_ID, name: 'postgres-volume', projectId: GATE_R1_METADATA_PROJECT_ID }
    };
    const result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ volumes: [volume] })) });
    expect(result.volumes[0].state).toBe('MIGRATING');

    volume.volume.projectId = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ volumes: [volume] })) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
    volume.volume.projectId = GATE_R1_METADATA_PROJECT_ID;
    volume.state = 'UNKNOWN';
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ volumes: [volume] })) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('requires unique volume-instance IDs and an environment-service owner', async () => {
    const serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0];
    const makeVolume = (volumeId, volumeInstanceId, owner = serviceId) => ({
      id: volumeInstanceId, serviceId: owner, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
      mountPath: '/data', state: 'READY',
      volume: { id: volumeId, name: `volume-${volumeId.slice(0, 4)}`, projectId: GATE_R1_METADATA_PROJECT_ID }
    });
    await expect(projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ volumes: [
        makeVolume(VOLUME_ID, VOLUME_INSTANCE_ID),
        makeVolume(ENDPOINT_ID, VOLUME_INSTANCE_ID)
      ] }))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
    await expect(projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ volumes: [makeVolume(VOLUME_ID, VOLUME_INSTANCE_ID, REPLACEMENT_SERVICE_ID)] }))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('rejects duplicate variable names within a service or the shared scope', async () => {
    const serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0];
    const variable = (id, scopedServiceId) => ({
      id, name: 'DUPLICATE_NAME', serviceId: scopedServiceId,
      environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, isSealed: true
    });
    for (const scopedServiceId of [serviceId, null]) {
      await expect(projectGateR1EnvironmentMetadata({
        env: env(),
        fetchImpl: fetchFor(payload({ variables: [
          variable(VARIABLE_ID, scopedServiceId),
          variable(ENDPOINT_ID, scopedServiceId)
        ] }))
      })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
    }
  });

  it('counts only nondeleted exact-target domains and rejects mismatched domain ownership', async () => {
    const serviceId = Object.keys(GATE_R1_APPROVED_SERVICES)[0];
    const domain = (id, deletedAt = null) => ({
      id, deletedAt, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, serviceId
    });
    const activeId = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    const deletedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const selected = service({ domains: {
      serviceDomains: [domain(activeId), domain(deletedId, '2026-07-19T10:00:00.000Z')],
      customDomains: []
    } });
    const result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ services: [selected] })) });
    expect(result.services[0].railwayDomainCount).toBe(1);

    selected.domains.serviceDomains[0].serviceId = REPLACEMENT_SERVICE_ID;
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ services: [selected] })) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('emits only safe start-command contract categories for the two replacements', async () => {
    const redis = service({ serviceId: REPLACEMENT_SERVICE_ID, serviceName: GATE_R1_REPLACEMENT_NAMES[1] });
    redis.startCommand = GATE_R1_APPROVED_REDIS_START_COMMAND;
    let result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ services: [redis] })) });
    expect(result.services[0].startCommandContract).toBe('APPROVED_REDIS');
    expect(JSON.stringify(result)).not.toContain(GATE_R1_APPROVED_REDIS_START_COMMAND);

    redis.startCommand = 'credential-sentinel unexpected command';
    result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ services: [redis] })) });
    expect(result.services[0].startCommandContract).toBe('MISMATCH');
    expect(JSON.stringify(result)).not.toContain('credential-sentinel');

    const postgres = service({ serviceId: REPLACEMENT_SERVICE_ID, serviceName: GATE_R1_REPLACEMENT_NAMES[0] });
    result = await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(payload({ services: [postgres] })) });
    expect(result.services[0].startCommandContract).toBe('UNSET');
  });

  it('classifies an unapproved image without returning its potentially sensitive source text', async () => {
    const sourceSentinel = 'registry.invalid/user:embedded-credential-sentinel';
    const result = await projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ services: [service({ source: { image: sourceSentinel, repo: null } })] }))
    });
    expect(result.services[0]).toMatchObject({
      sourceKind: 'IMAGE',
      sourceImage: null,
      sourceImageApproved: false
    });
    expect(JSON.stringify(result)).not.toContain(sourceSentinel);
  });

  it('projects endpoint presence without exposing endpoint identity or network host data', async () => {
    const serviceName = GATE_R1_REPLACEMENT_NAMES[1];
    const fetchImpl = fetchFor({ data: {
      projectToken: { projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID },
      service: { id: REPLACEMENT_SERVICE_ID, name: serviceName, projectId: GATE_R1_METADATA_PROJECT_ID },
      serviceInstance: {
        id: SERVICE_INSTANCE_ID,
        environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
        serviceId: REPLACEMENT_SERVICE_ID
      },
      privateNetworkEndpoint: {
        publicId: ENDPOINT_ID,
        deletedAt: null,
        serviceInstanceId: SERVICE_INSTANCE_ID,
        syncStatus: 'ACTIVE'
      }
    } });
    const result = await projectGateR1PrivateEndpoint({
      serviceId: REPLACEMENT_SERVICE_ID, serviceName, privateNetworkId: NETWORK_ID,
      env: env(), fetchImpl, clock: () => OBSERVED_AT
    });
    expect(result).toEqual({
      schemaVersion: 1,
      observedAt: OBSERVED_AT,
      projectId: GATE_R1_METADATA_PROJECT_ID,
      environmentId: GATE_R1_METADATA_ENVIRONMENT_ID,
      serviceId: REPLACEMENT_SERVICE_ID,
      serviceName,
      serviceInstanceId: SERVICE_INSTANCE_ID,
      privateNetworkId: NETWORK_ID,
      endpointPresent: true,
      endpointSyncStatus: 'ACTIVE'
    });
    expect(JSON.stringify(result)).not.toContain(ENDPOINT_ID);
  });

  it('rejects an endpoint bound to another service instance or an unknown sync state', async () => {
    const serviceName = GATE_R1_REPLACEMENT_NAMES[1];
    const endpointPayload = () => ({ data: {
      projectToken: { projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID },
      service: { id: REPLACEMENT_SERVICE_ID, name: serviceName, projectId: GATE_R1_METADATA_PROJECT_ID },
      serviceInstance: { id: SERVICE_INSTANCE_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, serviceId: REPLACEMENT_SERVICE_ID },
      privateNetworkEndpoint: { publicId: ENDPOINT_ID, deletedAt: null, serviceInstanceId: SERVICE_INSTANCE_ID, syncStatus: 'ACTIVE' }
    } });
    const options = { serviceId: REPLACEMENT_SERVICE_ID, serviceName, privateNetworkId: NETWORK_ID, env: env() };
    const wrongInstance = endpointPayload();
    wrongInstance.data.privateNetworkEndpoint.serviceInstanceId = VOLUME_INSTANCE_ID;
    await expect(projectGateR1PrivateEndpoint({ ...options, fetchImpl: fetchFor(wrongInstance) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
    const wrongStatus = endpointPayload();
    wrongStatus.data.privateNetworkEndpoint.syncStatus = 'UNKNOWN';
    await expect(projectGateR1PrivateEndpoint({ ...options, fetchImpl: fetchFor(wrongStatus) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('rejects project-token scope mismatch and every schema extra', async () => {
    const wrongScope = payload();
    wrongScope.data.projectToken.environmentId = '99999999-aaaa-4bbb-8ccc-dddddddddddd';
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(wrongScope) }))
      .rejects.toThrow('GATE_R1_METADATA_SCOPE_MISMATCH');

    await expect(projectGateR1EnvironmentMetadata({
      env: env(), fetchImpl: fetchFor(payload({ extraData: { variableValues: { unexpected: 'fixture-noncredential' } } }))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('rejects deployment statuses outside the pinned Railway 4.30.2 schema', async () => {
    const deployment = { id: DEPLOYMENT_ID, status: 'CANCELLED', createdAt: '2026-07-19T10:00:00.000Z' };
    await expect(projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: fetchFor(payload({ services: [service({ deployment })] }))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('rejects an invalid or throwing injected observation clock with a fixed code', async () => {
    for (const clock of [
      () => '2026-07-19 12:34:56',
      () => new Date(OBSERVED_AT),
      () => { throw new Error('clock-credential-sentinel'); }
    ]) {
      await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(), clock }))
        .rejects.toThrow('GATE_R1_METADATA_CLOCK_INVALID');
    }
  });

  it.each([
    ['service pagination', () => { const value = payload(); value.data.environment.serviceInstances.pageInfo.hasNextPage = true; return value; }],
    ['variable pagination', () => { const value = payload(); value.data.environment.variables.pageInfo.hasNextPage = true; return value; }],
    ['no active private network', () => payload({ networks: [] })],
    ['two active private networks', () => payload({ networks: [
      { publicId: NETWORK_ID, projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, deletedAt: null },
      { publicId: ENDPOINT_ID, projectId: GATE_R1_METADATA_PROJECT_ID, environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, deletedAt: null }
    ] })],
    ['duplicate service ID', () => payload({ services: [service(), service({ id: ENDPOINT_ID })] })],
    ['unbound variable', () => payload({ variables: [{
      id: VARIABLE_ID, name: 'SECRET_SENTINEL', serviceId: REPLACEMENT_SERVICE_ID,
      environmentId: GATE_R1_METADATA_ENVIRONMENT_ID, isSealed: true
    }] })]
  ])('fails closed on invalid bounded metadata: %s', async (_name, makePayload) => {
    await expect(projectGateR1EnvironmentMetadata({ env: env(), fetchImpl: fetchFor(makePayload()) }))
      .rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');
  });

  it('requires only the dedicated bounded project token and never falls back to broad tokens', async () => {
    const fetchImpl = fetchFor();
    for (const environment of [
      {},
      { RAILWAY_TOKEN: FIXTURE_PROJECT_ACCESS_VALUE },
      { RAILWAY_API_TOKEN: FIXTURE_PROJECT_ACCESS_VALUE },
      { [GATE_R1_METADATA_TOKEN_ENV]: ` ${FIXTURE_PROJECT_ACCESS_VALUE}` }
    ]) {
      await expect(projectGateR1EnvironmentMetadata({ env: environment, fetchImpl }))
        .rejects.toThrow(/GATE_R1_METADATA_TOKEN_(?:MISSING|INVALID)/);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds transport, maps diagnostics to fixed codes, and never retries', async () => {
    await expect(projectGateR1EnvironmentMetadata({
      env: env(),
      fetchImpl: jest.fn(async () => response('x'.repeat(GATE_R1_METADATA_RESPONSE_LIMIT_BYTES + 1)))
    })).rejects.toThrow('GATE_R1_METADATA_RESPONSE_INVALID');

    const fetchImpl = jest.fn(async () => { throw new Error('postgresql://secret@host SQL path token'); });
    let observed;
    try { await projectGateR1EnvironmentMetadata({ env: env(), fetchImpl }); } catch (error) { observed = error; }
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(observed.message).toBe('GATE_R1_METADATA_REQUEST_FAILED');
    expect(observed.message).not.toMatch(/postgresql|secret|SQL|path|token/i);
  });

  it('interrupts and cancels a hanging response reader at the fixed timeout', async () => {
    let timeoutCallback;
    const timeoutHandle = { unref: jest.fn() };
    const reader = {
      read: jest.fn(() => {
        timeoutCallback();
        return new Promise(() => {});
      }),
      cancel: jest.fn(async () => {}),
      releaseLock: jest.fn()
    };
    const fetchImpl = jest.fn(async () => ({
      status: 200,
      headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
      body: { getReader: () => reader }
    }));
    await expect(projectGateR1EnvironmentMetadata({
      env: env(), fetchImpl,
      setTimeoutImpl: jest.fn((callback) => { timeoutCallback = callback; return timeoutHandle; }),
      clearTimeoutImpl: jest.fn()
    })).rejects.toThrow('GATE_R1_METADATA_TIMEOUT');
    expect(reader.cancel).toHaveBeenCalled();
    expect(reader.releaseLock).toHaveBeenCalledTimes(1);
  });

  it('accepts only the fixed CLI contracts and writes only projected JSON or a fixed code', async () => {
    expect(parseGateR1MetadataArgs(['--environment'])).toEqual({ mode: 'environment' });
    expect(parseGateR1MetadataArgs([
      '--endpoint', '--service-id', REPLACEMENT_SERVICE_ID,
      '--service-name', GATE_R1_REPLACEMENT_NAMES[0], '--private-network-id', NETWORK_ID
    ])).toMatchObject({ mode: 'endpoint', serviceId: REPLACEMENT_SERVICE_ID, privateNetworkId: NETWORK_ID });
    expect(() => parseGateR1MetadataArgs(['--environment', '--extra'])).toThrow('GATE_R1_METADATA_ARGUMENT_INVALID');

    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    expect(await runGateR1MetadataCli({ argv: ['--environment'], stdout, stderr, env: env(), fetchImpl: fetchFor() })).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    expect(stdout.write).toHaveBeenCalledTimes(1);
    expect(stdout.write.mock.calls[0][0]).not.toContain(FIXTURE_PROJECT_ACCESS_VALUE);

    const failed = await runGateR1MetadataCli({
      argv: ['--environment'], stdout, stderr, env: env(),
      fetchImpl: jest.fn(async () => { throw new Error('credential-sentinel'); })
    });
    expect(failed).toBe(1);
    expect(stderr.write).toHaveBeenLastCalledWith('GATE_R1_METADATA_REQUEST_FAILED\n');
  });
});
