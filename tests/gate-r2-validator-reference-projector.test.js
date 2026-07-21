import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_REFERENCE_CATEGORIES,
  GATE_R2_VALIDATOR_PROFILES,
  GATE_R2_VALIDATOR_REFERENCE_ENDPOINT,
  GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
  GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
  GATE_R2_VALIDATOR_REFERENCE_QUERY,
  GATE_R2_VALIDATOR_REFERENCE_RESPONSE_LIMIT_BYTES,
  GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV,
  classifyGateR2ValidatorVariables,
  parseGateR2ValidatorReferenceArgs,
  projectGateR2ValidatorReference,
  runGateR2ValidatorReferenceProjectorCli
} from '../scripts/gate-r2-validator-reference-projector.js';

const TOKEN = 'railway-project-token-test-value';
const OBSERVED_AT = '2026-07-20T20:00:00.000Z';
const ACTIVE_DEPLOYMENT_ID = '11111111-2222-4333-8444-555555555555';
const WRONG_UUID = '99999999-aaaa-4bbb-8ccc-dddddddddddd';

function envWithToken(overrides = {}) {
  return {
    [GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV]: TOKEN,
    ...overrides
  };
}

function graphqlPayload({
  profile = 'migration-validator',
  variables = {},
  latestDeployment = null,
  activeDeployments = []
} = {}) {
  const target = GATE_R2_VALIDATOR_PROFILES[profile];
  return {
    data: {
      projectToken: {
        projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
        environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID
      },
      service: {
        id: target.serviceId,
        name: target.serviceName,
        projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID
      },
      serviceInstance: {
        id: target.serviceInstanceId,
        serviceId: target.serviceId,
        serviceName: target.serviceName,
        environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
        deletedAt: null,
        latestDeployment,
        activeDeployments
      },
      variables
    }
  };
}

function responseFor(payload, { status = 200, headers = {} } = {}) {
  return new Response(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
    {
      status,
      headers: {
        'content-type': 'application/json',
        ...headers
      }
    }
  );
}

function successFetch(payload) {
  return jest.fn(async () => responseFor(payload));
}

describe('Gate R2 validator reference projector', () => {
  it('pins exactly two inactive validator profiles and one fixed read-only query', () => {
    expect(GATE_R2_VALIDATOR_PROFILES).toEqual({
      'migration-validator': {
        serviceId: 'd8d5181a-2f72-48d7-8413-6f05d113876c',
        serviceInstanceId: '7a645cbc-dadf-4072-84c1-6f0843fa30d9',
        serviceName: 'phase2e-migration-validator-20260718'
      },
      'compatibility-validator': {
        serviceId: 'febdf999-1c96-48df-8e28-c905b8b27082',
        serviceInstanceId: '3c385dd2-c786-4149-9319-2a168a920aa9',
        serviceName: 'phase2e-compatibility-validator-20260718'
      }
    });
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain('query GateR2ValidatorReference');
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain('projectToken');
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain('service(id: $serviceId)');
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain(
      'serviceInstance(environmentId: $environmentId, serviceId: $serviceId)'
    );
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain('variables(');
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).toContain('unrendered: true');
    expect(GATE_R2_VALIDATOR_REFERENCE_QUERY).not.toMatch(
      /\bmutation\b|__schema|__type|environmentConfig|tcpProxies|serviceDomains|customDomains|\blogs\b/iu
    );
  });

  it.each([
    ['migration-validator'],
    ['compatibility-validator']
  ])('parses the exact %s profile CLI shape', (profile) => {
    expect(parseGateR2ValidatorReferenceArgs(['--profile', profile])).toEqual({ profile });
  });

  it('rejects arbitrary profiles and argument shapes before reading a token', async () => {
    for (const argv of [
      [],
      ['--profile'],
      ['--profile', 'migration-validator', '--extra'],
      [
        '--service-id',
        GATE_R2_VALIDATOR_PROFILES['migration-validator'].serviceId,
      ]
    ]) {
      expect(() => parseGateR2ValidatorReferenceArgs(argv)).toThrow(
        'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_ARGUMENT_INVALID'
      );
    }
    for (const profile of ['unknown', 'Migration', ' migration-validator', '__proto__']) {
      expect(() => parseGateR2ValidatorReferenceArgs(['--profile', profile])).toThrow(
        'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TARGET_FORBIDDEN'
      );
    }

    const env = new Proxy({}, {
      get() {
        throw new Error('must-not-read-token');
      }
    });
    const fetchImpl = jest.fn();
    await expect(projectGateR2ValidatorReference({ profile: 'unknown', env, fetchImpl }))
      .rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TARGET_FORBIDDEN');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['MISSING', {}, GATE_R2_REFERENCE_CATEGORIES.MISSING, 0],
    [
      'ORIGINAL_POSTGRES',
      { DATABASE_URL: '${{Postgres.DATABASE_URL}}' },
      GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES,
      1
    ],
    [
      'FAILED_POSTGRES_R2',
      { DATABASE_URL: '${{phase2e-postgres-r2-20260718.DATABASE_URL}}' },
      GATE_R2_REFERENCE_CATEGORIES.FAILED_POSTGRES_R2,
      1
    ],
    [
      'POSTGRES_R3',
      { DATABASE_URL: '${{phase2e-postgres-r3-20260720.DATABASE_URL}}' },
      GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3,
      1
    ],
    ['INVALID unknown string', { DATABASE_URL: 'unknown-reference' }, GATE_R2_REFERENCE_CATEGORIES.INVALID, 1],
    ['INVALID null', { DATABASE_URL: null }, GATE_R2_REFERENCE_CATEGORIES.INVALID, 1],
    ['INVALID number', { DATABASE_URL: 7 }, GATE_R2_REFERENCE_CATEGORIES.INVALID, 1],
    ['INVALID controls', { DATABASE_URL: 'bad\nreference' }, GATE_R2_REFERENCE_CATEGORIES.INVALID, 1]
  ])('classifies %s without returning a raw value', (_name, variables, category, count) => {
    const result = classifyGateR2ValidatorVariables(variables);
    expect(result).toEqual({ referenceCategory: category, variableCount: count });
    const serialized = JSON.stringify(result);
    for (const value of Object.values(variables)) {
      if (typeof value === 'string') {
        expect(serialized).not.toContain(value);
      }
    }
  });

  it('rejects extra variable keys instead of projecting them', () => {
    for (const variables of [
      { DATABASE_URL: '${{Postgres.DATABASE_URL}}', EXTRA: 'sentinel' },
      { REDIS_URL: 'sentinel' },
      [],
      null
    ]) {
      expect(() => classifyGateR2ValidatorVariables(variables)).toThrow(
        'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID'
      );
    }
  });

  it.each([
    ['migration-validator'],
    ['compatibility-validator']
  ])('projects the exact inactive %s validator and category-only result', async (profile) => {
    const target = GATE_R2_VALIDATOR_PROFILES[profile];
    const result = await projectGateR2ValidatorReference({
      profile,
      env: envWithToken(),
      fetchImpl: successFetch(graphqlPayload({
        profile,
        variables: { DATABASE_URL: '${{phase2e-postgres-r3-20260720.DATABASE_URL}}' }
      })),
      clock: () => OBSERVED_AT
    });

    expect(result).toEqual({
      projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
      environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
      validatorProfile: profile,
      serviceId: target.serviceId,
      serviceName: target.serviceName,
      serviceInstanceId: target.serviceInstanceId,
      observedAt: OBSERVED_AT,
      activeDeploymentCount: 0,
      variableCount: 1,
      referenceCategory: GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3
    });
    expect(JSON.stringify(result)).not.toContain('${{phase2e-postgres-r3');
  });

  it('sends only the fixed query, exact target variables, and project-token header', async () => {
    const fetchImpl = successFetch(graphqlPayload());
    await projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken({
        RAILWAY_API_TOKEN: 'ignored-broad-token',
        RAILWAY_TOKEN: 'ignored-cli-token'
      }),
      fetchImpl,
      clock: () => OBSERVED_AT
    });

    const [endpoint, init] = fetchImpl.mock.calls[0];
    expect(endpoint).toBe(GATE_R2_VALIDATOR_REFERENCE_ENDPOINT);
    expect(init.method).toBe('POST');
    expect(init.headers['Project-Access-Token']).toBe(TOKEN);
    expect(init.headers).not.toHaveProperty('Authorization');
    expect(init.redirect).toBe('error');
    expect(init.cache).toBe('no-store');
    expect(JSON.parse(init.body)).toEqual({
      query: GATE_R2_VALIDATOR_REFERENCE_QUERY,
      variables: {
        projectId: GATE_R2_VALIDATOR_REFERENCE_PROJECT_ID,
        environmentId: GATE_R2_VALIDATOR_REFERENCE_ENVIRONMENT_ID,
        serviceId: GATE_R2_VALIDATOR_PROFILES['migration-validator'].serviceId
      }
    });
    expect(init.body).not.toContain(TOKEN);
  });

  it.each([
    ['wrong token project', (value) => { value.data.projectToken.projectId = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['wrong token environment', (value) => { value.data.projectToken.environmentId = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['wrong service', (value) => { value.data.service.id = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['wrong service project', (value) => { value.data.service.projectId = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['wrong instance', (value) => { value.data.serviceInstance.id = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['wrong instance environment', (value) => { value.data.serviceInstance.environmentId = WRONG_UUID; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['deleted instance', (value) => { value.data.serviceInstance.deletedAt = '2026-07-20T19:00:00.000Z'; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TARGET_FORBIDDEN'],
    ['top-level extra', (value) => { value.errors = []; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID'],
    ['service extra', (value) => { value.data.service.extra = true; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH'],
    ['instance extra', (value) => { value.data.serviceInstance.extra = true; }, 'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_SCOPE_MISMATCH']
  ])('fails closed on %s', async (_name, mutate, code) => {
    const payload = graphqlPayload();
    mutate(payload);
    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: successFetch(payload)
    })).rejects.toThrow(code);
  });

  it.each([
    ['latest deployment', { latestDeployment: { id: ACTIVE_DEPLOYMENT_ID } }],
    ['active deployment', { activeDeployments: [{ id: ACTIVE_DEPLOYMENT_ID }] }]
  ])('rejects an inactive-contract violation: %s', async (_name, deployments) => {
    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: successFetch(graphqlPayload(deployments))
    })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_VALIDATOR_ACTIVE');
  });

  it('rejects malformed or duplicate deployment metadata before classifying activity', async () => {
    for (const activeDeployments of [
      [{ id: 'not-a-uuid' }],
      [{ id: ACTIVE_DEPLOYMENT_ID, extra: true }],
      [{ id: ACTIVE_DEPLOYMENT_ID }, { id: ACTIVE_DEPLOYMENT_ID }]
    ]) {
      await expect(projectGateR2ValidatorReference({
        profile: 'migration-validator',
        env: envWithToken(),
        fetchImpl: successFetch(graphqlPayload({ activeDeployments }))
      })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID');
    }
  });

  it('rejects missing or malformed tokens before network access', async () => {
    const fetchImpl = jest.fn();
    for (const env of [{}, { [GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV]: '   ' }]) {
      await expect(projectGateR2ValidatorReference({ profile: 'migration-validator', env, fetchImpl }))
        .rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TOKEN_MISSING');
    }
    for (const value of [' leading', 'trailing ', 'line\nbreak']) {
      await expect(projectGateR2ValidatorReference({
        profile: 'migration-validator',
        env: { [GATE_R2_VALIDATOR_REFERENCE_TOKEN_ENV]: value },
        fetchImpl
      })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_TOKEN_INVALID');
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('maps request and response failures to fixed codes without raw diagnostics', async () => {
    const sentinel = 'credential-and-path-sentinel';
    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: jest.fn(async () => { throw new Error(sentinel); })
    })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_REQUEST_FAILED');

    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: jest.fn(async () => responseFor('{}', { status: 500 }))
    })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID');

    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: jest.fn(async () => responseFor('{invalid-json'))
    })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID');

    await expect(projectGateR2ValidatorReference({
      profile: 'migration-validator',
      env: envWithToken(),
      fetchImpl: jest.fn(async () => responseFor('{}', {
        headers: { 'content-length': String(GATE_R2_VALIDATOR_REFERENCE_RESPONSE_LIMIT_BYTES + 1) }
      }))
    })).rejects.toThrow('GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_RESPONSE_INVALID');
  });

  it('emits only the fixed JSON result and fixed errors through the CLI boundary', async () => {
    const secretReference = 'secret-reference-sentinel';
    const stdout = { write: jest.fn() };
    const stderr = { write: jest.fn() };
    const exitCode = await runGateR2ValidatorReferenceProjectorCli({
      argv: ['--profile', 'compatibility-validator'],
      stdout,
      stderr,
      env: envWithToken(),
      fetchImpl: successFetch(graphqlPayload({
        profile: 'compatibility-validator',
        variables: { DATABASE_URL: secretReference }
      })),
      clock: () => OBSERVED_AT
    });
    expect(exitCode).toBe(0);
    expect(stderr.write).not.toHaveBeenCalled();
    const output = stdout.write.mock.calls[0][0];
    expect(JSON.parse(output)).toMatchObject({
      validatorProfile: 'compatibility-validator',
      referenceCategory: GATE_R2_REFERENCE_CATEGORIES.INVALID,
      activeDeploymentCount: 0,
      variableCount: 1
    });
    expect(output).not.toContain(secretReference);
    expect(output).not.toContain(TOKEN);

    const failureStdout = { write: jest.fn() };
    const failureStderr = { write: jest.fn() };
    const failureCode = await runGateR2ValidatorReferenceProjectorCli({
      argv: ['--profile', 'migration-validator'],
      stdout: failureStdout,
      stderr: failureStderr,
      env: envWithToken(),
      fetchImpl: jest.fn(async () => { throw new Error(secretReference); })
    });
    expect(failureCode).toBe(1);
    expect(failureStdout.write).not.toHaveBeenCalled();
    expect(failureStderr.write).toHaveBeenCalledWith(
      'GATE_R2_VALIDATOR_REFERENCE_PROJECTOR_REQUEST_FAILED\n'
    );
    expect(failureStderr.write.mock.calls[0][0]).not.toContain(secretReference);
  });
});
