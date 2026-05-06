import { describe, expect, it, jest } from '@jest/globals';

const {
  createCapabilityRegistry
} = await import('../src/dispatcher/naturalLanguage/index.js');
const {
  routeOperatorCommandThroughDispatch,
  runGptAccessNaturalLanguageDispatch
} = await import('../src/services/gptAccessNaturalLanguageDispatch.js');

describe('GPT Access natural-language dispatch service', () => {
  it('returns confirmation_required for privileged plans instead of executing', async () => {
    const runCapability = jest.fn();
    const registry = createCapabilityRegistry([
      {
        action: 'ARCANOS:CORE.query',
        requiredScope: 'capabilities.run',
        risk: 'privileged',
        requiresConfirmation: true,
        runner: {
          kind: 'gpt-access-capability',
          capabilityId: 'ARCANOS:CORE',
          capabilityAction: 'query'
        }
      }
    ]);

    const response = await runGptAccessNaturalLanguageDispatch({
      utterance: 'ARCANOS:CORE.query',
      registry,
      isScopeAllowed: () => true,
      isModuleActionAllowed: () => true,
      handlers: {
        runMcpTool: jest.fn(),
        runDiagnostics: jest.fn(),
        runWorkerRecovery: jest.fn(),
        runCapability
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.policy.status).toBe('confirmation_required');
    expect(response.payload).toEqual(expect.objectContaining({
      ok: false,
      error: {
        code: 'CONFIRMATION_REQUIRED',
        message: 'Dispatch confirmation is required before execution.'
      },
      confirmationRequired: true,
      confirmation: {
        retryEndpoint: '/gpt-access/dispatch/run',
        confirmationTokenField: 'confirmation_token'
      },
      plan: expect.objectContaining({
        action: 'ARCANOS:CORE.query'
      }),
      policy: expect.objectContaining({
        status: 'confirmation_required',
        requiresConfirmation: true,
        shouldExecute: false
      })
    }));
    expect(runCapability).not.toHaveBeenCalled();
  });

  it('does not intercept general fix questions as backend operator commands', async () => {
    await expect(routeOperatorCommandThroughDispatch({
      utterance: 'how do I fix a TypeScript bug in my app?'
    })).resolves.toBeNull();
  });

  it('does not intercept explanatory writing prompts that mention backend or queue terms', async () => {
    await expect(routeOperatorCommandThroughDispatch({
      utterance: 'Explain the backend architecture for a queue-based app.'
    })).resolves.toBeNull();

    await expect(routeOperatorCommandThroughDispatch({
      utterance: 'Write me a story about broken workers.'
    })).resolves.toBeNull();
  });
});
