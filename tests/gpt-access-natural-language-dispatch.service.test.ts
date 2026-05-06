import { describe, expect, it, jest } from '@jest/globals';

const {
  createCapabilityRegistry
} = await import('../src/dispatcher/naturalLanguage/index.js');
const {
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
});
