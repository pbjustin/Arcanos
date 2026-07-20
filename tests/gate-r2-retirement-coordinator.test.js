import { describe, expect, it, jest } from '@jest/globals';
import {
  GATE_R2_COORDINATOR_MAXIMUM_REQUESTS,
  GATE_R2_COORDINATOR_TOKEN_ENV,
  createGateR2CoordinatorProcessAdapter,
  runGateR2RetirementCoordinator,
  runGateR2RetirementCoordinatorCli
} from '../scripts/gate-r2-retirement-coordinator.js';
import {
  GATE_R2_REFERENCE_CATEGORIES,
  GATE_R2_VALIDATOR_PROFILES
} from '../scripts/gate-r2-validator-reference-projector.js';
import {
  GATE_R2_ACTIVE_REPLACEMENTS,
  GATE_R2_ENVIRONMENT_ID,
  GATE_R2_INACTIVE_CONSUMERS,
  GATE_R2_PRIVATE_NETWORK_ID,
  GATE_R2_PROJECT_ID,
  GATE_R2_RETIREMENT_ORDER,
  GATE_R2_RETIREMENT_TARGETS
} from '../scripts/gate-r2-retirement-state-projector.js';
import { GATE_R2_VALIDATOR_TARGETS } from '../scripts/gate-r2-validator-cutover.js';
import { GATE_R2_VOLUME_DISPOSITION_TARGETS } from '../scripts/gate-r2-volume-disposition.js';

const OBSERVED_AT = '2026-07-20T21:00:00.000Z';
const CREATED_AT = '2026-07-20T20:59:00.000Z';
const SESSION_PROCESS_ID = 4242;
const SESSION_SCRIPT_SHA256 = 'A'.repeat(64);

function validatorProjection(profile, category) {
  const target = GATE_R2_VALIDATOR_PROFILES[profile];
  return {
    projectId: GATE_R2_PROJECT_ID,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    validatorProfile: profile,
    serviceId: target.serviceId,
    serviceName: target.serviceName,
    serviceInstanceId: target.serviceInstanceId,
    observedAt: OBSERVED_AT,
    activeDeploymentCount: 0,
    variableCount: category === GATE_R2_REFERENCE_CATEGORIES.MISSING ? 0 : 1,
    referenceCategory: category
  };
}

function targetEntry(profile, state) {
  const expected = GATE_R2_RETIREMENT_TARGETS[profile];
  return {
    profile,
    serviceId: expected.serviceId,
    serviceInstanceId: expected.serviceInstanceId,
    serviceState: state.retired.has(profile) ? 'TOMBSTONED' : 'PRESENT',
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 10,
    sourceImage: profile === 'original-redis' ? 'redis:8.2.1' : null,
    latestDeployment: null,
    activeDeployments: [],
    activeDeploymentCount: 0,
    latestDeploymentPresent: false,
    railwayDomainCount: 0,
    customDomainCount: 0,
    variableNameCount: 0,
    publicUrlVariableCount: 0,
    variableNameState: 'OBSERVED',
    tcpProxyCount: 0,
    volume: {
      profile,
      volumeId: expected.volumeId,
      volumeInstanceId: expected.volumeInstanceId,
      volumeState: state.volumes[profile]
    }
  };
}

function replacementEntry(profile) {
  const expected = GATE_R2_ACTIVE_REPLACEMENTS[profile];
  return {
    profile,
    serviceId: expected.serviceId,
    serviceInstanceId: expected.serviceInstanceId,
    serviceState: 'PRESENT',
    restartPolicyType: 'ON_FAILURE',
    restartPolicyMaxRetries: 3,
    sourceImage: expected.image,
    latestDeployment: { id: expected.deploymentId, status: 'SUCCESS' },
    activeDeployments: [{ id: expected.deploymentId, status: 'SUCCESS' }],
    activeDeploymentCount: 1,
    railwayDomainCount: 0,
    customDomainCount: 0,
    sourceState: 'MATCH',
    deploymentState: 'HEALTHY',
    restartPolicyState: 'MATCH',
    variableNameCount: expected.variableNames.length,
    publicUrlVariableCount: 0,
    variableNameState: 'MATCH',
    privateEndpointState: 'ACTIVE',
    tcpProxyCount: 0,
    volume: {
      profile,
      volumeId: expected.volumeId,
      volumeInstanceId: expected.volumeInstanceId,
      volumeState: 'RETAINED_ATTACHED'
    }
  };
}

function consumerEntry(profile) {
  const expected = GATE_R2_INACTIVE_CONSUMERS[profile];
  const isValidator = expected.requiredPresent === true;
  return {
    profile,
    serviceId: expected.serviceId,
    serviceInstanceId: expected.serviceInstanceId,
    serviceState: isValidator ? 'PRESENT' : 'ABSENT',
    activeDeploymentCount: 0,
    latestDeploymentPresent: false,
    railwayDomainCount: 0,
    customDomainCount: 0,
    tcpProxyCount: 0,
    variableNameCount: isValidator ? 1 : 0,
    publicUrlVariableCount: 0,
    variableNameState: isValidator ? 'MATCH' : 'OBSERVED',
    referenceCategory: isValidator ? 'POSTGRES_R3' : 'NOT_APPLICABLE'
  };
}

function retirementProjection(request, state) {
  return {
    schemaVersion: 2,
    observedAt: OBSERVED_AT,
    projectId: GATE_R2_PROJECT_ID,
    environmentId: GATE_R2_ENVIRONMENT_ID,
    privateNetworkId: GATE_R2_PRIVATE_NETWORK_ID,
    phase: request.phase,
    retiredProfile: request.phase === 'post' ? request.profile : null,
    disposedProfile: request.phase === 'final' ? request.profile : null,
    status: 'PASS',
    reasonCodes: [],
    sharedVariableCount: 0,
    targets: GATE_R2_RETIREMENT_ORDER.map(profile => targetEntry(profile, state)),
    replacements: Object.keys(GATE_R2_ACTIVE_REPLACEMENTS).map(replacementEntry),
    consumers: Object.keys(GATE_R2_INACTIVE_CONSUMERS).map(consumerEntry)
  };
}

function validatorMutationResult(profile) {
  const target = GATE_R2_VALIDATOR_TARGETS[profile];
  return {
    code: 'GATE_R2_VALIDATOR_CUTOVER_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: target.serviceId,
    status: 'PENDING_PROJECTION'
  };
}

function retirementMutationResult(profile) {
  const target = GATE_R2_RETIREMENT_TARGETS[profile];
  return {
    code: 'GATE_R2_RETIREMENT_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    serviceId: target.serviceId,
    serviceInstanceId: target.serviceInstanceId,
    status: 'PENDING_PROJECTION'
  };
}

function volumeMutationResult(profile) {
  const target = GATE_R2_VOLUME_DISPOSITION_TARGETS[profile];
  return {
    code: 'GATE_R2_VOLUME_DISPOSITION_ACCEPTED_PENDING_PROJECTION',
    environmentId: GATE_R2_ENVIRONMENT_ID,
    profile,
    projectId: GATE_R2_PROJECT_ID,
    projectionRequired: true,
    retryAuthorized: false,
    status: 'PENDING_PROJECTION',
    volumeId: target.volumeId,
    volumeInstanceId: target.volumeInstanceId
  };
}

function createHarness({
  baseline = {
    'migration-validator': GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES,
    'compatibility-validator': GATE_R2_REFERENCE_CATEGORIES.FAILED_POSTGRES_R2
  },
  retireVolumeState = 'RETAINED_DETACHED',
  responseHook,
  processOverrides = {},
  readyOverrides = {},
  exitCode = 0
} = {}) {
  const state = {
    references: { ...baseline },
    retired: new Set(),
    volumes: Object.fromEntries(GATE_R2_RETIREMENT_ORDER.map(profile => [
      profile,
      'RETAINED_ATTACHED'
    ]))
  };
  const requests = [];
  const acknowledgements = [];
  const mutationCalls = [];
  const waitForSessionExit = jest.fn(async () => exitCode);

  const fileAdapter = {
    readReady: jest.fn(() => ({
      protocolVersion: 1,
      status: 'ready',
      projectId: GATE_R2_PROJECT_ID,
      environmentId: GATE_R2_ENVIRONMENT_ID,
      maximumRequests: GATE_R2_COORDINATOR_MAXIMUM_REQUESTS,
      createdAt: CREATED_AT,
      sessionProcessId: SESSION_PROCESS_ID,
      sessionProcessIdentity: '638886240000000000',
      sessionScriptSha256: SESSION_SCRIPT_SHA256,
      ...readyOverrides
    })),
    writeRequest: jest.fn((sequence, request) => {
      requests.push({ sequence, request: structuredClone(request) });
    }),
    waitForResponse: jest.fn(async sequence => {
      const selected = requests.find(entry => entry.sequence === sequence);
      if (!selected) throw new Error('raw-missing-request-sentinel');
      const request = selected.request;
      let response;
      if (request.operation === 'stop') {
        response = {
          protocolVersion: 1,
          sequence,
          status: 'stopped',
          completedLedger: sequence === GATE_R2_COORDINATOR_MAXIMUM_REQUESTS
        };
      } else {
        let result;
        if (request.operation === 'validatorReference') {
          const profile = request.profile === 'migration'
            ? 'migration-validator'
            : 'compatibility-validator';
          result = validatorProjection(profile, state.references[profile]);
        } else {
          result = retirementProjection(request, state);
        }
        response = { protocolVersion: 1, sequence, status: 'ok', result };
      }
      return typeof responseHook === 'function'
        ? responseHook({ request, response, sequence, state }) ?? response
        : response;
    }),
    writeAcknowledgement: jest.fn(value => {
      acknowledgements.push(structuredClone(value));
    })
  };

  const processAdapter = {
    validatorCutover: jest.fn(async profile => {
      mutationCalls.push(`validator:${profile}`);
      state.references[profile] = GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3;
      return validatorMutationResult(profile);
    }),
    retireService: jest.fn(async profile => {
      mutationCalls.push(`retire:${profile}`);
      state.retired.add(profile);
      state.volumes[profile] = retireVolumeState;
      return retirementMutationResult(profile);
    }),
    disposeVolume: jest.fn(async profile => {
      mutationCalls.push(`volume:${profile}`);
      state.volumes[profile] = 'ABSENT';
      return volumeMutationResult(profile);
    }),
    waitForSessionExit,
    ...processOverrides
  };
  return {
    acknowledgements,
    fileAdapter,
    mutationCalls,
    processAdapter,
    requests,
    state,
    waitForSessionExit
  };
}

function runHarness(harness, options = {}) {
  return runGateR2RetirementCoordinator({
    environment: {},
    fileAdapter: harness.fileAdapter,
    processAdapter: harness.processAdapter,
    ...options
  });
}

function expectConsumedAcknowledgement(harness, sequence) {
  expect(harness.acknowledgements).toEqual([{
    consumedThroughSequence: sequence,
    protocolVersion: 1,
    sequence,
    status: 'consumed'
  }]);
  expect(harness.waitForSessionExit).toHaveBeenCalledTimes(1);
}

describe('Gate R2 retirement coordinator', () => {
  it('owns the exact fourteen-step happy path and invokes every mutation once', async () => {
    const harness = createHarness();
    const result = await runHarness(harness);

    expect(result).toEqual({
      code: 'GATE_R2_COORDINATOR_COMPLETE',
      environmentId: GATE_R2_ENVIRONMENT_ID,
      finalOldVolumeState: 'ABSENT',
      projectId: GATE_R2_PROJECT_ID,
      requestsConsumed: 14,
      serviceRetirementCount: 3,
      sessionExitVerified: true,
      status: 'PASS',
      validatorCutoverCount: 2,
      volumeDispositionCount: 3
    });
    expect(harness.requests.map(({ request }) => request)).toEqual([
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 1 },
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 2 },
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 3 },
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 4 },
      { operation: 'validatorReference', profile: 'migration', protocolVersion: 1, sequence: 5 },
      { operation: 'validatorReference', profile: 'compatibility', protocolVersion: 1, sequence: 6 },
      { operation: 'retirementState', phase: 'pre', protocolVersion: 1, sequence: 7 },
      { operation: 'retirementState', phase: 'post', profile: 'original-postgres', protocolVersion: 1, sequence: 8 },
      { operation: 'retirementState', phase: 'post', profile: 'failed-postgres-r2', protocolVersion: 1, sequence: 9 },
      { operation: 'retirementState', phase: 'post', profile: 'original-redis', protocolVersion: 1, sequence: 10 },
      { operation: 'retirementState', phase: 'final', profile: 'original-postgres', protocolVersion: 1, sequence: 11 },
      { operation: 'retirementState', phase: 'final', profile: 'failed-postgres-r2', protocolVersion: 1, sequence: 12 },
      { operation: 'retirementState', phase: 'final', profile: 'original-redis', protocolVersion: 1, sequence: 13 },
      { operation: 'stop', protocolVersion: 1, sequence: 14 }
    ]);
    expect(harness.mutationCalls).toEqual([
      'validator:migration-validator',
      'validator:compatibility-validator',
      'retire:original-postgres',
      'retire:failed-postgres-r2',
      'retire:original-redis',
      'volume:original-postgres',
      'volume:failed-postgres-r2',
      'volume:original-redis'
    ]);
    expectConsumedAcknowledgement(harness, 14);
  });

  it('uses the three cumulative requests but skips volume mutations already made absent by Railway', async () => {
    const harness = createHarness({ retireVolumeState: 'ABSENT' });
    const result = await runHarness(harness);
    expect(result.volumeDispositionCount).toBe(0);
    expect(harness.processAdapter.disposeVolume).not.toHaveBeenCalled();
    expect(harness.requests).toHaveLength(14);
    expectConsumedAcknowledgement(harness, 14);
  });

  it.each([
    [GATE_R2_REFERENCE_CATEGORIES.MISSING],
    [GATE_R2_REFERENCE_CATEGORIES.INVALID]
  ])('blocks an unsafe migration-validator baseline category %s and stops next', async category => {
    const harness = createHarness({
      baseline: {
        'migration-validator': category,
        'compatibility-validator': GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_POSTCONDITION_FAILED');
    expect(harness.requests.map(({ request }) => request.operation)).toEqual([
      'validatorReference', 'stop'
    ]);
    expect(harness.mutationCalls).toEqual([]);
    expectConsumedAcknowledgement(harness, 2);
  });

  it('stops before projection when a validator mutation fails before invocation', async () => {
    const harness = createHarness();
    harness.processAdapter.validatorCutover = jest.fn(async () => {
      throw new Error('GATE_R2_VALIDATOR_CUTOVER_TARGET_MISMATCH');
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_MUTATION_FAILED');
    expect(harness.requests.map(({ request }) => request.operation)).toEqual([
      'validatorReference', 'validatorReference', 'stop'
    ]);
    expect(harness.processAdapter.validatorCutover).toHaveBeenCalledTimes(1);
    expectConsumedAcknowledgement(harness, 3);
  });

  it('projects once and continues after an ambiguous validator mutation that took effect', async () => {
    const harness = createHarness();
    const original = harness.processAdapter.validatorCutover;
    harness.processAdapter.validatorCutover = jest.fn(async profile => {
      if (profile === 'migration-validator') {
        harness.state.references[profile] = GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3;
        throw new Error('GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS');
      }
      return original(profile);
    });
    await expect(runHarness(harness)).resolves.toMatchObject({ status: 'PASS' });
    expect(harness.processAdapter.validatorCutover).toHaveBeenCalledTimes(2);
    expect(harness.processAdapter.validatorCutover.mock.calls.filter(
      ([profile]) => profile === 'migration-validator'
    )).toHaveLength(1);
  });

  it('projects once, never retries, and stops when an ambiguous validator mutation did not take effect', async () => {
    const harness = createHarness();
    harness.processAdapter.validatorCutover = jest.fn(async () => {
      throw new Error('GATE_R2_VALIDATOR_CUTOVER_MUTATION_AMBIGUOUS');
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_POSTCONDITION_FAILED');
    expect(harness.processAdapter.validatorCutover).toHaveBeenCalledTimes(1);
    expect(harness.requests.map(({ request }) => request.operation)).toEqual([
      'validatorReference', 'validatorReference', 'validatorReference', 'stop'
    ]);
    expectConsumedAcknowledgement(harness, 4);
  });

  it('projects once but stops after a malformed mutation acknowledgement', async () => {
    const harness = createHarness();
    harness.processAdapter.validatorCutover = jest.fn(async profile => {
      harness.state.references[profile] = GATE_R2_REFERENCE_CATEGORIES.POSTGRES_R3;
      return {};
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_MUTATION_RESULT_INVALID');
    expect(harness.processAdapter.validatorCutover).toHaveBeenCalledTimes(1);
    expect(harness.requests.map(({ request }) => request.operation)).toEqual([
      'validatorReference', 'validatorReference', 'validatorReference', 'stop'
    ]);
    expectConsumedAcknowledgement(harness, 4);
  });

  it('continues after one ambiguous service retirement only when its postprojection proves retirement', async () => {
    const harness = createHarness();
    const original = harness.processAdapter.retireService;
    harness.processAdapter.retireService = jest.fn(async profile => {
      if (profile === 'original-postgres') {
        harness.state.retired.add(profile);
        harness.state.volumes[profile] = 'RETAINED_DETACHED';
        throw new Error('GATE_R2_RETIREMENT_MUTATION_AMBIGUOUS');
      }
      return original(profile);
    });
    await expect(runHarness(harness)).resolves.toMatchObject({ status: 'PASS' });
    expect(harness.processAdapter.retireService.mock.calls.filter(
      ([profile]) => profile === 'original-postgres'
    )).toHaveLength(1);
  });

  it('continues after one ambiguous volume disposition only when the volume is absent', async () => {
    const harness = createHarness();
    const original = harness.processAdapter.disposeVolume;
    harness.processAdapter.disposeVolume = jest.fn(async profile => {
      if (profile === 'original-postgres') {
        harness.state.volumes[profile] = 'ABSENT';
        throw new Error('GATE_R2_VOLUME_DISPOSITION_MUTATION_AMBIGUOUS');
      }
      return original(profile);
    });
    await expect(runHarness(harness)).resolves.toMatchObject({ status: 'PASS' });
    expect(harness.processAdapter.disposeVolume.mock.calls.filter(
      ([profile]) => profile === 'original-postgres'
    )).toHaveLength(1);
  });

  it('requires an absent post-state and never retries a detached volume after disposition', async () => {
    const harness = createHarness();
    harness.processAdapter.disposeVolume = jest.fn(async profile => volumeMutationResult(profile));
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_POSTCONDITION_FAILED');
    expect(harness.processAdapter.disposeVolume).toHaveBeenCalledTimes(1);
    expect(harness.requests.at(-1).request.operation).toBe('stop');
    expect(harness.requests.at(-1).sequence).toBe(12);
    expectConsumedAcknowledgement(harness, 12);
  });

  it('rejects inner BLOCKED retirement state even when the session envelope says ok', async () => {
    const harness = createHarness({
      responseHook({ response, sequence }) {
        if (sequence === 7) {
          response.result.status = 'BLOCKED';
          response.result.reasonCodes = ['FIXTURE_BLOCKED'];
        }
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_POSTCONDITION_FAILED');
    expect(harness.processAdapter.retireService).not.toHaveBeenCalled();
    expect(harness.requests.at(-1)).toMatchObject({ sequence: 8, request: { operation: 'stop' } });
    expectConsumedAcknowledgement(harness, 8);
  });

  it.each([
    ['replacement private endpoint', result => { result.replacements[0].privateEndpointState = 'MISMATCH'; }],
    ['validator reference', result => { result.consumers[2].referenceCategory = 'INVALID'; }],
    ['consumer TCP proxy', result => { result.consumers[0].tcpProxyCount = 1; }],
    ['shared variable count', result => { result.sharedVariableCount = 1; }]
  ])('rejects a final Gate C mismatch in %s before reporting completion', async (_name, mutate) => {
    const harness = createHarness({
      responseHook({ response, sequence }) {
        if (sequence === 13) mutate(response.result);
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_POSTCONDITION_FAILED');
    expect(harness.requests.at(-1)).toMatchObject({ sequence: 14, request: { operation: 'stop' } });
    expectConsumedAcknowledgement(harness, 14);
  });

  it('rejects extra response fields and stops at the next sequence', async () => {
    const harness = createHarness({
      responseHook({ response, sequence }) {
        if (sequence === 1) response.extra = true;
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_RESPONSE_INVALID');
    expect(harness.requests.at(-1)).toMatchObject({ sequence: 2, request: { operation: 'stop' } });
    expectConsumedAcknowledgement(harness, 2);
  });

  it('acknowledges the final stop but fails closed when session exit is not zero', async () => {
    const harness = createHarness({ retireVolumeState: 'ABSENT', exitCode: 1 });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_ABORT_FAILED');
    expect(harness.requests.at(-1)).toMatchObject({ sequence: 14, request: { operation: 'stop' } });
    expectConsumedAcknowledgement(harness, 14);
  });

  it('writes the consumed acknowledgement even when the stop response is malformed', async () => {
    const harness = createHarness({
      baseline: {
        'migration-validator': GATE_R2_REFERENCE_CATEGORIES.MISSING,
        'compatibility-validator': GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES
      },
      responseHook({ response, request }) {
        if (request.operation === 'stop') return { status: 'malformed' };
        return response;
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_ABORT_FAILED');
    expectConsumedAcknowledgement(harness, 2);
  });

  it('rejects completedLedger true on an early abort stop', async () => {
    const harness = createHarness({
      baseline: {
        'migration-validator': GATE_R2_REFERENCE_CATEGORIES.MISSING,
        'compatibility-validator': GATE_R2_REFERENCE_CATEGORIES.ORIGINAL_POSTGRES
      },
      responseHook({ response, request }) {
        if (request.operation === 'stop') response.completedLedger = true;
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_ABORT_FAILED');
    expectConsumedAcknowledgement(harness, 2);
  });

  it('rejects completedLedger false on the final stop', async () => {
    const harness = createHarness({
      responseHook({ response, request }) {
        if (request.operation === 'stop') response.completedLedger = false;
      }
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_ABORT_FAILED');
    expectConsumedAcknowledgement(harness, 14);
  });

  it('rejects an ambient projector token before reading the session or invoking mutations', async () => {
    const harness = createHarness();
    await expect(runHarness(harness, {
      environment: { [GATE_R2_COORDINATOR_TOKEN_ENV]: 'must-not-be-read' }
    })).rejects.toThrow('GATE_R2_COORDINATOR_AMBIENT_TOKEN_FORBIDDEN');
    expect(harness.fileAdapter.readReady).not.toHaveBeenCalled();
    expect(harness.mutationCalls).toEqual([]);
    expect(harness.waitForSessionExit).not.toHaveBeenCalled();
  });

  it('requires an injected session-exit waiter before reading ready state', async () => {
    const harness = createHarness();
    delete harness.processAdapter.waitForSessionExit;
    await expect(runHarness(harness)).rejects.toThrow(
      'GATE_R2_COORDINATOR_SESSION_EXIT_WAITER_REQUIRED'
    );
    expect(harness.fileAdapter.readReady).not.toHaveBeenCalled();
    expect(() => createGateR2CoordinatorProcessAdapter()).toThrow(
      'GATE_R2_COORDINATOR_SESSION_EXIT_WAITER_REQUIRED'
    );
  });

  it('rejects a session whose ready contract does not advertise fourteen requests', async () => {
    const harness = createHarness({ readyOverrides: { maximumRequests: 12 } });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_READY_INVALID');
    expect(harness.requests).toEqual([]);
    expect(harness.waitForSessionExit).not.toHaveBeenCalled();
  });

  it('requires the session-authored process start identity in ready state', async () => {
    const harness = createHarness({ readyOverrides: { sessionProcessIdentity: 'invalid' } });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_READY_INVALID');
    expect(harness.requests).toEqual([]);
    expect(harness.waitForSessionExit).not.toHaveBeenCalled();
  });

  it('maps raw file failures to a fixed code without exposing diagnostics', async () => {
    const harness = createHarness();
    harness.fileAdapter.readReady = jest.fn(() => {
      throw new Error('credential-path-sql-sentinel');
    });
    await expect(runHarness(harness)).rejects.toThrow('GATE_R2_COORDINATOR_FILE_IO_FAILED');
  });

  it('keeps the direct entrypoint disabled without a bound session owner', async () => {
    const stderr = { write: jest.fn() };
    await expect(runGateR2RetirementCoordinatorCli({ stderr })).resolves.toBe(1);
    expect(stderr.write).toHaveBeenCalledWith(
      'GATE_R2_COORDINATOR_SESSION_EXIT_WAITER_REQUIRED\n'
    );
  });
});
