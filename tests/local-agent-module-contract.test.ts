import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

import ArcanosLocalAgent from '../src/services/arcanos-local-agent.js';
import {
  LOCAL_AGENT_ACTIONS,
  LOCAL_AGENT_ACTION_INPUT_SCHEMAS,
  LOCAL_AGENT_ACTION_METADATA,
  LOCAL_AGENT_ACTION_OUTPUT_SCHEMAS,
  LOCAL_AGENT_CAPABILITY_CATALOG,
  LOCAL_AGENT_MODULE_NAME,
  LocalAgentContractValidationError,
  validateLocalAgentActionInput,
  validateLocalAgentActionOutput
} from '../src/services/localAgent/contracts.js';
import {
  configureLocalAgentActionExecutor,
  type LocalAgentActionExecutor
} from '../src/services/localAgent/executor.js';
import { localAgentResultInputSchema } from '../src/services/localAgent/protocol.js';

const trustedContext = {
  source: 'gpt-access' as const,
  principalId: 'operator:primary',
  workspaceId: 'personal',
  actorKey: 'actor:test',
  requestId: 'request:test',
  traceId: 'trace:test',
  idempotencyKey: 'turn:test'
};

afterEach(() => {
  configureLocalAgentActionExecutor(null);
});

describe('ARCANOS:LOCAL_AGENT module contract', () => {
  test('keeps the generated Python-daemon catalog in exact parity', () => {
    const generated = JSON.parse(
      readFileSync(
        new URL(
          '../packages/protocol/schemas/v1/local-agent/capability-catalog.generated.json',
          import.meta.url
        ),
        'utf8'
      )
    ) as unknown;
    expect(generated).toEqual({
      schemaVersion: 'local-agent-capability-catalog-v1',
      module: LOCAL_AGENT_MODULE_NAME,
      actions: LOCAL_AGENT_ACTIONS.map(
        (action) => LOCAL_AGENT_CAPABILITY_CATALOG[action]
      )
    });
  });

  test('publishes only the seven protected Python-daemon actions', () => {
    expect(ArcanosLocalAgent).toMatchObject({
      name: LOCAL_AGENT_MODULE_NAME,
      defaultAction: 'local_agent.status',
      exposeLegacyRoute: false,
      gptAccessOnly: true
    });
    expect(Object.keys(ArcanosLocalAgent.actions).sort()).toEqual(
      [...LOCAL_AGENT_ACTIONS].sort()
    );
    expect(Object.keys(ArcanosLocalAgent.actionMetadata ?? {}).sort()).toEqual(
      [...LOCAL_AGENT_ACTIONS].sort()
    );
  });

  test('publishes complete schema-first execution metadata for every action', () => {
    for (const action of LOCAL_AGENT_ACTIONS) {
      const contract = LOCAL_AGENT_CAPABILITY_CATALOG[action];
      expect(LOCAL_AGENT_ACTION_METADATA[action]).toEqual({
        description: contract.description,
        risk: contract.risk,
        requiresConfirmation: contract.requiresConfirmation,
        inputSchema: LOCAL_AGENT_ACTION_INPUT_SCHEMAS[action],
        outputSchema: LOCAL_AGENT_ACTION_OUTPUT_SCHEMAS[action],
        idempotent: contract.idempotent,
        executionTarget: 'python-daemon',
        timeoutMs: contract.timeoutMs,
        requiredDeviceScopes: [action],
        readOnly: contract.readOnly,
        mayModifyFiles: contract.mayModifyFiles
      });
      expect(contract.inputSchema).toEqual(expect.objectContaining({
        type: 'object',
        additionalProperties: false
      }));
      expect(contract.outputSchema).toEqual(expect.objectContaining({
        type: 'object',
        additionalProperties: false
      }));
    }

    expect(LOCAL_AGENT_CAPABILITY_CATALOG['patch.apply']).toMatchObject({
      risk: 'privileged',
      requiresConfirmation: true,
      readOnly: false,
      mayModifyFiles: true
    });
    expect(LOCAL_AGENT_CAPABILITY_CATALOG['tests.run']).toMatchObject({
      risk: 'privileged',
      requiresConfirmation: true,
      readOnly: false,
      mayModifyFiles: true
    });
  });

  test('validates action payloads and rejects authority, root, and generic-command fields', () => {
    expect(
      validateLocalAgentActionInput('repo.search', {
        query: 'LocalAgentAction',
        options: {
          path: 'src/services',
          type: 'symbol',
          limit: 20
        }
      })
    ).toEqual({
      query: 'LocalAgentAction',
      options: {
        path: 'src/services',
        type: 'symbol',
        limit: 20
      }
    });
    expect(
      validateLocalAgentActionInput('tests.run', {
        profile: 'python-unit'
      })
    ).toEqual({ profile: 'python-unit' });

    for (const payload of [
      { query: 'needle', workspaceId: 'other' },
      { query: 'needle', root: 'C:\\outside' },
      { query: 'needle', deviceId: 'agent-2' },
      { query: 'needle', confirmation: true },
      { query: 'needle', authorization: 'allow' },
      { query: 'needle', command: 'git status' }
    ]) {
      expect(() => validateLocalAgentActionInput('repo.search', payload))
        .toThrow(LocalAgentContractValidationError);
    }

    expect(() =>
      validateLocalAgentActionInput('repo.search', {
        query: 'needle',
        options: { path: '..\\outside' }
      })
    ).toThrow(LocalAgentContractValidationError);
    expect(() =>
      validateLocalAgentActionInput('tests.run', {
        profile: 'custom',
        command: 'npm run anything'
      })
    ).toThrow(LocalAgentContractValidationError);
  });

  test('validates sanitized outputs and rejects local root leakage', () => {
    expect(
      validateLocalAgentActionOutput('local_agent.status', {
        status: 'ready',
        daemonVersion: '1.0.0',
        capabilities: [...LOCAL_AGENT_ACTIONS],
        workspaceRegistered: true,
        testExecutionMode: 'sandboxed',
        testSandboxAvailable: true,
        testSandboxRuntime: 'docker',
        observedAt: '2026-07-24T12:00:00.000Z'
      })
    ).toMatchObject({
      status: 'ready',
      workspaceRegistered: true,
      testExecutionMode: 'sandboxed',
      testSandboxAvailable: true,
      testSandboxRuntime: 'docker'
    });
    expect(
      validateLocalAgentActionOutput('local_agent.status', {
        status: 'degraded',
        daemonVersion: '1.0.0',
        capabilities: [...LOCAL_AGENT_ACTIONS],
        workspaceRegistered: true,
        testExecutionMode: 'disabled',
        testSandboxAvailable: false,
        testSandboxRuntime: null,
        observedAt: '2026-07-24T12:00:00.000Z'
      })
    ).toMatchObject({
      testExecutionMode: 'disabled',
      testSandboxAvailable: false,
      testSandboxRuntime: null
    });
    expect(
      validateLocalAgentActionOutput('tests.run', {
        profile: 'typescript-unit',
        status: 'passed',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 120,
        truncated: false
      })
    ).toMatchObject({
      status: 'passed',
      exitCode: 0
    });
    expect(() =>
      validateLocalAgentActionOutput('git.diff', {
        rootPath: 'C:\\private\\workspace',
        base: 'main',
        head: 'HEAD',
        diff: '',
        bytes: 0,
        truncated: false
      })
    ).toThrow(LocalAgentContractValidationError);
  });

  test('rejects failed result envelopes that try to return unvalidated output', () => {
    expect(localAgentResultInputSchema.safeParse({
      protocolVersion: 'local-agent-job-v1',
      resultKey: 'result-key-1',
      outcome: 'failed',
      output: { 'secret': 'test-value-must-not-be-persisted' },
      error: {
        code: 'LOCAL_AGENT_EXECUTION_FAILED',
        message: 'The allowlisted operation failed.',
        classification: 'execution',
        retryable: false
      },
      metrics: {
        durationMs: 1,
        outputTruncated: false
      },
      correlation: {
        traceId: 'trace:test',
        requestId: 'request:test',
        deviceId: 'device:test'
      }
    }).success).toBe(false);
  });

  test('keeps the maximum published git diff inside the result transport limit', () => {
    const output = validateLocalAgentActionOutput('git.diff', {
      base: 'main',
      head: 'HEAD',
      diff: 'x'.repeat(65_536),
      bytes: 65_536,
      truncated: false
    });

    expect(localAgentResultInputSchema.safeParse({
      protocolVersion: 'local-agent-job-v1',
      resultKey: 'result-key-1',
      outcome: 'succeeded',
      output,
      metrics: {
        durationMs: 1,
        outputTruncated: false
      },
      correlation: {
        traceId: 'trace:test',
        requestId: 'request:test',
        deviceId: 'device:test'
      }
    }).success).toBe(true);
    expect(() =>
      validateLocalAgentActionOutput('git.diff', {
        ...output,
        diff: `${output.diff}x`,
        bytes: 65_537
      })
    ).toThrow(LocalAgentContractValidationError);
  });

  test('keeps the maximum patch payload within the bounded assignment transport', () => {
    const patchSchema = LOCAL_AGENT_ACTION_INPUT_SCHEMAS['patch.apply']
      .properties as Record<string, {
        maxLength?: number;
        maxUtf8Bytes?: number;
      }>;

    expect(patchSchema.patch?.maxLength).toBe(200_000);
    expect(patchSchema.patch?.maxUtf8Bytes).toBe(200_000);
    expect(() =>
      validateLocalAgentActionInput('patch.apply', {
        patch: '\u{10FFFF}'.repeat(50_001),
        expectedPatchSha256: 'a'.repeat(64)
      })
    ).toThrow(LocalAgentContractValidationError);
    expect(
      Buffer.byteLength(
        JSON.stringify({
          protocolVersion: 'local-agent-job-v1',
          payload: {
            patch: '\u{10FFFF}'.repeat(patchSchema.patch?.maxLength ?? 0),
            expectedPatchSha256: 'a'.repeat(64)
          }
        }),
        'utf8'
      )
    ).toBeLessThanOrEqual(1536 * 1024);
  });

  test('fails closed without trusted context or a configured durable executor', async () => {
    await expect(
      ArcanosLocalAgent.actions['local_agent.status']?.({})
    ).resolves.toMatchObject({
      ok: false,
      action: 'local_agent.status',
      error: {
        code: 'PERMISSION_DENIED'
      }
    });
    await expect(
      ArcanosLocalAgent.actions['local_agent.status']?.({}, trustedContext)
    ).resolves.toMatchObject({
      ok: false,
      action: 'local_agent.status',
      error: {
        code: 'DEPENDENCY_UNAVAILABLE'
      }
    });
  });

  test('passes only validated payload and trusted context to the configured executor', async () => {
    const executor = jest.fn<LocalAgentActionExecutor>(async (request) => ({
      ok: true,
      jobId: 'job-local-agent-1',
      action: request.action
    }));
    configureLocalAgentActionExecutor(executor);

    await expect(
      ArcanosLocalAgent.actions['git.diff']?.(
        {
          base: 'main',
          head: 'HEAD',
          contextLines: 5
        },
        trustedContext
      )
    ).resolves.toEqual({
      ok: true,
      jobId: 'job-local-agent-1',
      action: 'git.diff'
    });
    expect(executor).toHaveBeenCalledWith({
      action: 'git.diff',
      payload: {
        base: 'main',
        head: 'HEAD',
        contextLines: 5
      },
      context: trustedContext
    });

    await expect(
      ArcanosLocalAgent.actions['git.diff']?.(
        {
          base: 'main',
          head: 'HEAD',
          workspaceId: 'attacker'
        },
        trustedContext
      )
    ).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'VALIDATION_FAILED'
      }
    });
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
