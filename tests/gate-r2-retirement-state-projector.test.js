import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_ACTIVE_REPLACEMENTS,
  GATE_R2_ENVIRONMENT_ID,
  GATE_R2_GRAPHQL_ENDPOINT,
  GATE_R2_INACTIVE_CONSUMERS,
  GATE_R2_PRIVATE_NETWORK_ID,
  GATE_R2_PROJECT_ID,
  GATE_R2_RESPONSE_LIMIT_BYTES,
  GATE_R2_RETIREMENT_ORDER,
  GATE_R2_RETIREMENT_STATE_QUERY,
  GATE_R2_RETIREMENT_TARGETS,
  GATE_R2_TOKEN_ENV,
  parseGateR2RetirementArgs,
  projectGateR2RetirementResponse,
  projectGateR2RetirementState
} from '../scripts/gate-r2-retirement-state-projector.js';

const TOKEN = 'railway-project-token-test-value';
const OBSERVED_AT = '2026-07-20T20:00:00.000Z';
const R3_REFERENCE = '${{phase2e-postgres-r3-20260720.DATABASE_URL}}';
const NETWORK_ENDPOINT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const ALL = Object.freeze({
  ...GATE_R2_RETIREMENT_TARGETS,
  ...GATE_R2_ACTIVE_REPLACEMENTS,
  ...GATE_R2_INACTIVE_CONSUMERS
});

let idCounter = 1;
function nextUuid() {
  return `10000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;
}

function env() { return { [GATE_R2_TOKEN_ENV]: TOKEN }; }

function deployment(id, status = 'SUCCESS') { return { id, status }; }

function service(profile, overrides = {}) {
  const expected = ALL[profile];
  const replacement = GATE_R2_ACTIVE_REPLACEMENTS[profile];
  const activeDeployment = replacement ? deployment(replacement.deploymentId) : null;
  return {
    id: expected.serviceInstanceId,
    serviceId: expected.serviceId,
    serviceName: expected.serviceName,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    deletedAt: null,
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    source: replacement ? { image: replacement.image } : null,
    latestDeployment: activeDeployment,
    activeDeployments: activeDeployment ? [activeDeployment] : [],
    domains: { serviceDomains: [], customDomains: [] },
    ...overrides
  };
}

function volume(profile, overrides = {}) {
  const expected = ALL[profile];
  return {
    id: expected.volumeInstanceId,
    serviceId: expected.serviceId,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    mountPath: expected.mountPath,
    state: 'READY',
    volume: { id: expected.volumeId, projectId: GATE_R2_PROJECT_ID },
    ...overrides
  };
}

function variable(serviceId, name, overrides = {}) {
  return {
    id: nextUuid(),
    name,
    serviceId,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    isSealed: true,
    ...overrides
  };
}

function replacementVariables() {
  return Object.entries(GATE_R2_ACTIVE_REPLACEMENTS).flatMap(([, expected]) =>
    expected.variableNames.map(name => variable(expected.serviceId, name))
  );
}

function validatorVariables() {
  return ['migration-validator', 'compatibility-validator'].map(profile =>
    variable(GATE_R2_INACTIVE_CONSUMERS[profile].serviceId, 'DATABASE_URL')
  );
}

function targetVariables() {
  return GATE_R2_RETIREMENT_ORDER.map(profile => {
    const expected = GATE_R2_RETIREMENT_TARGETS[profile];
    const name = profile.includes('redis') ? 'REDIS_PUBLIC_URL' : 'DATABASE_PUBLIC_URL';
    return variable(expected.serviceId, name);
  });
}

function connection(nodes) {
  return { pageInfo: { hasNextPage: false }, edges: nodes.map(node => ({ node })) };
}

function endpoint(profile, overrides = {}) {
  const expected = GATE_R2_ACTIVE_REPLACEMENTS[profile];
  return {
    publicId: NETWORK_ENDPOINT_ID,
    deletedAt: null,
    serviceInstanceId: expected.serviceInstanceId,
    syncStatus: 'ACTIVE',
    ...overrides
  };
}

function payload({
  services,
  volumes,
  variables,
  validatorReferences = {},
  endpoints = {},
  tcp = {},
  extraData = {}
} = {}) {
  idCounter = 1;
  const defaultServices = [
    ...GATE_R2_RETIREMENT_ORDER,
    ...Object.keys(GATE_R2_ACTIVE_REPLACEMENTS),
    'migration-validator',
    'compatibility-validator'
  ].map(profile => service(profile));
  return {
    data: {
      projectToken: { projectId: GATE_R2_PROJECT_ID, environmentId: GATE_R2_ENVIRONMENT_ID },
      project: { id: GATE_R2_PROJECT_ID, name: 'Arcanos' },
      environment: {
        id: GATE_R2_ENVIRONMENT_ID,
        name: 'phase2e-validation-20260717',
        projectId: GATE_R2_PROJECT_ID,
        serviceInstances: connection(services ?? defaultServices),
        volumeInstances: connection(volumes ?? [
          ...GATE_R2_RETIREMENT_ORDER,
          ...Object.keys(GATE_R2_ACTIVE_REPLACEMENTS)
        ].map(profile => volume(profile))),
        variables: connection(variables ?? [
          ...replacementVariables(), ...validatorVariables(), ...targetVariables()
        ])
      },
      privateNetworks: [{
        publicId: GATE_R2_PRIVATE_NETWORK_ID,
        projectId: GATE_R2_PROJECT_ID,
        environmentId: GATE_R2_ENVIRONMENT_ID,
        deletedAt: null
      }],
      postgresR3Endpoint: endpoints['postgres-r3'] ?? endpoint('postgres-r3'),
      redisR2Endpoint: endpoints['redis-r2'] ?? endpoint('redis-r2'),
      migrationValidatorVariables: validatorReferences.migration ?? { DATABASE_URL: R3_REFERENCE },
      compatibilityValidatorVariables: validatorReferences.compatibility ?? { DATABASE_URL: R3_REFERENCE },
      originalPostgresTcp: tcp['original-postgres'] ?? [],
      failedPostgresR2Tcp: tcp['failed-postgres-r2'] ?? [],
      originalRedisTcp: tcp['original-redis'] ?? [],
      postgresR3Tcp: tcp['postgres-r3'] ?? [],
      redisR2Tcp: tcp['redis-r2'] ?? [],
      arcanosV2Tcp: tcp['arcanos-v2'] ?? [],
      arcanosWorkerTcp: tcp['arcanos-worker'] ?? [],
      migrationValidatorTcp: tcp['migration-validator'] ?? [],
      compatibilityValidatorTcp: tcp['compatibility-validator'] ?? [],
      ...extraData
    }
  };
}

function postPayload(profile) {
  const retiredThrough = GATE_R2_RETIREMENT_ORDER.indexOf(profile);
  const retired = new Set(GATE_R2_RETIREMENT_ORDER.slice(0, retiredThrough + 1));
  const services = [
    ...GATE_R2_RETIREMENT_ORDER.filter(item => !retired.has(item)),
    ...Object.keys(GATE_R2_ACTIVE_REPLACEMENTS),
    'migration-validator', 'compatibility-validator'
  ].map(item => service(item));
  const variables = [
    ...replacementVariables(), ...validatorVariables(),
    ...GATE_R2_RETIREMENT_ORDER.filter(item => !retired.has(item)).map(item => {
      const expected = GATE_R2_RETIREMENT_TARGETS[item];
      return variable(expected.serviceId, item.includes('redis') ? 'REDIS_PUBLIC_URL' : 'DATABASE_PUBLIC_URL');
    })
  ];
  return payload({ services, variables });
}

function finalPayload(profile) {
  const disposedThrough = GATE_R2_RETIREMENT_ORDER.indexOf(profile);
  const services = [
    ...Object.keys(GATE_R2_ACTIVE_REPLACEMENTS),
    'migration-validator', 'compatibility-validator'
  ].map(item => service(item));
  const targetVolumes = GATE_R2_RETIREMENT_ORDER.flatMap((item, index) => {
    if (index <= disposedThrough) return [];
    return [volume(item, { serviceId: null })];
  });
  return payload({
    services,
    volumes: [
      ...targetVolumes,
      ...Object.keys(GATE_R2_ACTIVE_REPLACEMENTS).map(item => volume(item))
    ],
    variables: [...replacementVariables(), ...validatorVariables()]
  });
}

function response(value, { status = 200, headers = {} } = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('Gate R2 retirement state projector', () => {
  it('pins exact target, replacement, and inactive-consumer identities', () => {
    expect(GATE_R2_RETIREMENT_ORDER).toEqual([
      'original-postgres', 'failed-postgres-r2', 'original-redis'
    ]);
    expect(GATE_R2_INACTIVE_CONSUMERS).toEqual({
      'arcanos-v2': {
        serviceId: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
        serviceInstanceId: null,
        serviceName: 'ARCANOS V2',
        requiredPresent: false,
        tcpAlias: 'arcanosV2Tcp'
      },
      'arcanos-worker': {
        serviceId: '1765befb-b805-4051-9af9-28634e986886',
        serviceInstanceId: null,
        serviceName: 'ARCANOS Worker',
        requiredPresent: false,
        tcpAlias: 'arcanosWorkerTcp'
      },
      'migration-validator': expect.objectContaining({
        serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
        serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9'
      }),
      'compatibility-validator': expect.objectContaining({
        serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
        serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9'
      })
    });
    expect(GATE_R2_ACTIVE_REPLACEMENTS['postgres-r3'].deploymentId)
      .toBe('b5e45d34-19b8-4253-b230-c3ab0b60b0d7');
    expect(GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].deploymentId)
      .toBe('9f102e53-ef25-46b5-80e8-0243eb1512d6');
  });

  it('uses one bounded names-only inventory plus fixed endpoint/reference/proxy queries', () => {
    expect(GATE_R2_RETIREMENT_STATE_QUERY).toContain('serviceInstances(first: 100)');
    expect(GATE_R2_RETIREMENT_STATE_QUERY).toContain('variables(first: 100)');
    expect(GATE_R2_RETIREMENT_STATE_QUERY).toContain('node { id name serviceId environmentId isSealed }');
    expect(GATE_R2_RETIREMENT_STATE_QUERY).toContain('privateNetworkEndpoint(');
    expect(GATE_R2_RETIREMENT_STATE_QUERY).toContain('unrendered: true');
    expect(GATE_R2_RETIREMENT_STATE_QUERY).not.toMatch(/environmentConfig|decryptVariables|hostname|fqdn|\blogs\b/iu);
  });

  it('parses only pre, post, and cumulative final fixed profiles', () => {
    expect(parseGateR2RetirementArgs(['--phase', 'pre'])).toEqual({ phase: 'pre', profile: null });
    expect(parseGateR2RetirementArgs([
      '--phase', 'post', '--profile', 'original-postgres'
    ])).toEqual({ phase: 'post', profile: 'original-postgres' });
    expect(parseGateR2RetirementArgs([
      '--phase', 'final', '--profile', 'original-redis'
    ])).toEqual({ phase: 'final', profile: 'original-redis' });
    for (const argv of [
      [], ['--phase', 'final'], ['--phase', 'other'],
      ['--phase', 'post', '--profile', 'redis-r2']
    ]) expect(() => parseGateR2RetirementArgs(argv)).toThrow('GATE_R2_RETIREMENT_ARGUMENT_INVALID');
  });

  it('passes the complete pre-retirement isolation state', () => {
    const result = projectGateR2RetirementResponse(payload(), {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    });
    expect(result).toMatchObject({
      schemaVersion: 2,
      phase: 'pre',
      status: 'PASS',
      privateNetworkId: GATE_R2_PRIVATE_NETWORK_ID,
      reasonCodes: []
    });
    expect(result.replacements).toHaveLength(2);
    expect(result.replacements.every(item => item.privateEndpointState === 'ACTIVE')).toBe(true);
    expect(result.replacements.every(item => item.restartPolicyState === 'MATCH')).toBe(true);
    expect(result.consumers.map(item => [item.profile, item.serviceState])).toEqual([
      ['arcanos-v2', 'ABSENT'],
      ['arcanos-worker', 'ABSENT'],
      ['migration-validator', 'PRESENT'],
      ['compatibility-validator', 'PRESENT']
    ]);
    expect(result.consumers.every(item => item.tcpProxyCount === 0)).toBe(true);
  });

  it.each(GATE_R2_RETIREMENT_ORDER)(
    'passes cumulative service retirement through %s',
    profile => {
      const result = projectGateR2RetirementResponse(postPayload(profile), {
        phase: 'post', profile, observedAt: OBSERVED_AT
      });
      expect(result.status).toBe('PASS');
      expect(result.retiredProfile).toBe(profile);
    }
  );

  it.each(GATE_R2_RETIREMENT_ORDER)(
    'passes cumulative volume disposition through %s only when processed volumes are absent',
    profile => {
      const result = projectGateR2RetirementResponse(finalPayload(profile), {
        phase: 'final', profile, observedAt: OBSERVED_AT
      });
      expect(result.status).toBe('PASS');
      expect(result.disposedProfile).toBe(profile);
      const processed = GATE_R2_RETIREMENT_ORDER.slice(0, GATE_R2_RETIREMENT_ORDER.indexOf(profile) + 1);
      for (const item of result.targets.filter(target => processed.includes(target.profile))) {
        expect(item.volume.volumeState).toBe('ABSENT');
      }
    }
  );

  it('blocks skipped retirement order and a selected final volume that remains detached', () => {
    const skipped = postPayload('original-postgres');
    skipped.data.environment.serviceInstances = connection(
      skipped.data.environment.serviceInstances.edges
        .map(({ node }) => node)
        .filter(node => node.serviceId !== GATE_R2_RETIREMENT_TARGETS['failed-postgres-r2'].serviceId)
    );
    const skippedResult = projectGateR2RetirementResponse(skipped, {
      phase: 'post', profile: 'original-postgres', observedAt: OBSERVED_AT
    });
    expect(skippedResult.status).toBe('BLOCKED');
    expect(skippedResult.reasonCodes).toContain('SERVICE_STATE_FAILED_POSTGRES_R2');

    const incomplete = finalPayload('original-postgres');
    incomplete.data.environment.volumeInstances.edges.push({
      node: volume('original-postgres', { serviceId: null })
    });
    const incompleteResult = projectGateR2RetirementResponse(incomplete, {
      phase: 'final', profile: 'original-postgres', observedAt: OBSERVED_AT
    });
    expect(incompleteResult.status).toBe('BLOCKED');
    expect(incompleteResult.reasonCodes).toContain('VOLUME_STATE_ORIGINAL_POSTGRES');
  });

  it('blocks every replacement drift category without normalizing it away', () => {
    const cases = [
      { service: { source: { image: 'redis:latest' } } },
      { service: { restartPolicyMaxRetries: 10 } },
      { service: { activeDeployments: [], latestDeployment: null } },
      { endpoint: { syncStatus: 'CREATING' } },
      { variableName: 'REDIS_PUBLIC_URL' },
      { volume: { serviceId: null } }
    ];
    for (const item of cases) {
      const base = payload();
      if (item.service) {
        base.data.environment.serviceInstances.edges = base.data.environment.serviceInstances.edges.map(edge =>
          edge.node.serviceId === GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].serviceId
            ? { node: service('redis-r2', item.service) } : edge
        );
      }
      if (item.endpoint) base.data.redisR2Endpoint = endpoint('redis-r2', item.endpoint);
      if (item.variableName) base.data.environment.variables.edges.push({
        node: variable(GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].serviceId, item.variableName)
      });
      if (item.volume) base.data.environment.volumeInstances.edges = base.data.environment.volumeInstances.edges.map(edge =>
        edge.node.serviceId === GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].serviceId
          ? { node: volume('redis-r2', item.volume) } : edge
      );
      const result = projectGateR2RetirementResponse(base, {
        phase: 'pre', profile: null, observedAt: OBSERVED_AT
      });
      expect(result.status).toBe('BLOCKED');
      expect(result.reasonCodes).toContain('REPLACEMENT_STATE_REDIS_R2');
    }
  });

  it('blocks active or reintroduced consumers and rejects unknown inventory entries', () => {
    const activeValidator = payload();
    activeValidator.data.environment.serviceInstances.edges = activeValidator.data.environment.serviceInstances.edges.map(edge =>
      edge.node.serviceId === GATE_R2_INACTIVE_CONSUMERS['migration-validator'].serviceId
        ? { node: service('migration-validator', {
          latestDeployment: deployment('11111111-2222-4333-8444-555555555555'),
          activeDeployments: [deployment('11111111-2222-4333-8444-555555555555')]
        }) } : edge
    );
    expect(projectGateR2RetirementResponse(activeValidator, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    }).reasonCodes).toContain('CONSUMER_STATE_MIGRATION_VALIDATOR');

    for (const [profile, reasonCode] of [
      ['arcanos-v2', 'CONSUMER_STATE_ARCANOS_V2'],
      ['arcanos-worker', 'CONSUMER_STATE_ARCANOS_WORKER'],
      ['migration-validator', 'CONSUMER_STATE_MIGRATION_VALIDATOR'],
      ['compatibility-validator', 'CONSUMER_STATE_COMPATIBILITY_VALIDATOR']
    ]) {
      const proxiedConsumer = payload({
        tcp: { [profile]: [{
          id: '11111111-2222-4333-8444-555555555555',
          serviceId: GATE_R2_INACTIVE_CONSUMERS[profile].serviceId,
          environmentId: GATE_R2_ENVIRONMENT_ID,
          deletedAt: null
        }] }
      });
      expect(projectGateR2RetirementResponse(proxiedConsumer, {
        phase: 'pre', profile: null, observedAt: OBSERVED_AT
      }).reasonCodes).toContain(reasonCode);
    }

    const app = payload();
    app.data.environment.serviceInstances.edges.push({
      node: { ...service('migration-validator'),
        id: '11111111-2222-4333-8444-555555555555',
        serviceId: GATE_R2_INACTIVE_CONSUMERS['arcanos-v2'].serviceId,
        serviceName: 'ARCANOS V2' }
    });
    expect(() => projectGateR2RetirementResponse(app, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');

    const unknown = payload();
    unknown.data.environment.serviceInstances.edges.push({
      node: { ...service('migration-validator'),
        id: '22222222-2222-4222-8222-222222222222',
        serviceId: '33333333-3333-4333-8333-333333333333',
        serviceName: 'unexpected' }
    });
    expect(() => projectGateR2RetirementResponse(unknown, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  });

  it('requires validator R3 references but never emits an unrendered value', () => {
    const sentinel = 'postgresql://credential-sentinel/private/path';
    const result = projectGateR2RetirementResponse(payload({
      validatorReferences: { migration: { DATABASE_URL: sentinel } }
    }), { phase: 'pre', profile: null, observedAt: OBSERVED_AT });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('CONSUMER_STATE_MIGRATION_VALIDATOR');
    expect(JSON.stringify(result)).not.toContain(sentinel);

    const extra = projectGateR2RetirementResponse(payload({
      validatorReferences: { migration: { DATABASE_URL: R3_REFERENCE, SECRET: sentinel } }
    }), { phase: 'pre', profile: null, observedAt: OBSERVED_AT });
    expect(extra.status).toBe('BLOCKED');
    expect(JSON.stringify(extra)).not.toContain(sentinel);
  });

  it('blocks stale service-scoped variable names after retirement', () => {
    const base = postPayload('original-postgres');
    base.data.environment.variables.edges.push({
      node: variable(GATE_R2_RETIREMENT_TARGETS['original-postgres'].serviceId, 'DATABASE_PUBLIC_URL')
    });
    const result = projectGateR2RetirementResponse(base, {
      phase: 'post', profile: 'original-postgres', observedAt: OBSERVED_AT
    });
    expect(result.status).toBe('BLOCKED');
    expect(result.reasonCodes).toContain('VARIABLE_STATE_ORIGINAL_POSTGRES');
  });

  it('rejects pagination, duplicate services, unknown variable scopes, and extra variable fields', () => {
    const paginated = payload();
    paginated.data.environment.serviceInstances.pageInfo.hasNextPage = true;
    expect(() => projectGateR2RetirementResponse(paginated, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');

    const duplicate = payload();
    duplicate.data.environment.serviceInstances.edges.push({ node: service('migration-validator') });
    expect(() => projectGateR2RetirementResponse(duplicate, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');

    const unknownVariable = payload();
    unknownVariable.data.environment.variables.edges.push({
      node: variable('11111111-2222-4333-8444-555555555555', 'DATABASE_URL')
    });
    expect(() => projectGateR2RetirementResponse(unknownVariable, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');

    const extraField = payload();
    extraField.data.environment.variables.edges[0].node.value = 'credential-sentinel';
    expect(() => projectGateR2RetirementResponse(extraField, {
      phase: 'pre', profile: null, observedAt: OBSERVED_AT
    })).toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');
  });

  it('sends the exact fixed no-cache request and emits no token, URL, or raw value', async () => {
    const fetchImpl = jest.fn(async () => response(payload()));
    const result = await projectGateR2RetirementState({
      phase: 'pre', env: env(), fetchImpl, clock: () => OBSERVED_AT
    });
    expect(result.status).toBe('PASS');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [endpointValue, request] = fetchImpl.mock.calls[0];
    expect(endpointValue).toBe(GATE_R2_GRAPHQL_ENDPOINT);
    expect(request).toMatchObject({
      method: 'POST',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        accept: 'application/json',
        'cache-control': 'no-store',
        'content-type': 'application/json',
        pragma: 'no-cache',
        'Project-Access-Token': TOKEN
      }
    });
    expect(request.headers).not.toHaveProperty('authorization');
    expect(JSON.parse(request.body)).toEqual({
      query: GATE_R2_RETIREMENT_STATE_QUERY,
      variables: {
        projectId: GATE_R2_PROJECT_ID,
        environmentId: GATE_R2_ENVIRONMENT_ID,
        privateNetworkId: GATE_R2_PRIVATE_NETWORK_ID,
        originalPostgresServiceId: GATE_R2_RETIREMENT_TARGETS['original-postgres'].serviceId,
        originalRedisServiceId: GATE_R2_RETIREMENT_TARGETS['original-redis'].serviceId,
        failedPostgresR2ServiceId: GATE_R2_RETIREMENT_TARGETS['failed-postgres-r2'].serviceId,
        postgresR3ServiceId: GATE_R2_ACTIVE_REPLACEMENTS['postgres-r3'].serviceId,
        redisR2ServiceId: GATE_R2_ACTIVE_REPLACEMENTS['redis-r2'].serviceId,
        arcanosV2ServiceId: GATE_R2_INACTIVE_CONSUMERS['arcanos-v2'].serviceId,
        arcanosWorkerServiceId: GATE_R2_INACTIVE_CONSUMERS['arcanos-worker'].serviceId,
        migrationValidatorServiceId: GATE_R2_INACTIVE_CONSUMERS['migration-validator'].serviceId,
        compatibilityValidatorServiceId: GATE_R2_INACTIVE_CONSUMERS['compatibility-validator'].serviceId
      }
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toMatch(/postgres(?:ql)?:\/\/|redis:\/\//iu);
  });

  it('fails closed for tokens, malformed responses, oversized bodies, and transport errors', async () => {
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: {}, fetchImpl: jest.fn(), clock: () => OBSERVED_AT
    })).rejects.toThrow('GATE_R2_RETIREMENT_TOKEN_MISSING');
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: { [GATE_R2_TOKEN_ENV]: 'bad token' }, fetchImpl: jest.fn(), clock: () => OBSERVED_AT
    })).rejects.toThrow('GATE_R2_RETIREMENT_TOKEN_INVALID');
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: env(), fetchImpl: jest.fn(async () => response('{')), clock: () => OBSERVED_AT
    })).rejects.toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: env(),
      fetchImpl: jest.fn(async () => response('x', {
        headers: { 'content-length': String(GATE_R2_RESPONSE_LIMIT_BYTES + 1) }
      })),
      clock: () => OBSERVED_AT
    })).rejects.toThrow('GATE_R2_RETIREMENT_RESPONSE_INVALID');
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: env(),
      fetchImpl: jest.fn(async () => { throw new Error('Bearer secret /path'); }),
      clock: () => OBSERVED_AT
    })).rejects.toThrow('GATE_R2_RETIREMENT_REQUEST_FAILED');
  });

  it('maps stalled response bodies to the fixed timeout code', async () => {
    const pending = jest.fn(async () => new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(projectGateR2RetirementState({
      phase: 'pre', env: env(), fetchImpl: pending, clock: () => OBSERVED_AT, timeoutMs: 5
    })).rejects.toThrow('GATE_R2_RETIREMENT_TIMEOUT');
  });
});
