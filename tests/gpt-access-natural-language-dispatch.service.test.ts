import { describe, expect, it, jest } from '@jest/globals';

const {
  createCapabilityRegistry,
  createGptAccessDispatchRegistry,
  evaluateDispatchPolicy,
  resolveRuleBasedDispatchPlan
} = await import('../src/dispatcher/naturalLanguage/index.js');
const {
  routeOperatorCommandThroughDispatch,
  runGptAccessNaturalLanguageDispatch
} = await import('../src/services/gptAccessNaturalLanguageDispatch.js');

describe('GPT Access natural-language dispatch service', () => {
  it('registers ARCANOS:CLI module actions as privileged capability dispatch targets', () => {
    const registry = createGptAccessDispatchRegistry([
      {
        id: 'ARCANOS:CLI',
        description: 'ARCANOS CLI bridge',
        route: 'arcanos-cli',
        actions: ['repoContext', 'status']
      }
    ]);

    const actions = registry.listActions();
    const cliStatus = registry.getAction('ARCANOS:CLI.status');
    const cliRepoContext = registry.getAction('ARCANOS:CLI.repoContext');

    expect(actions.map((entry) => entry.action)).toEqual(expect.arrayContaining([
      'ARCANOS:CLI.repoContext',
      'ARCANOS:CLI.status'
    ]));
    expect(cliStatus).toEqual(expect.objectContaining({
      requiredScope: 'capabilities.run',
      risk: 'privileged',
      requiresConfirmation: true,
      runner: {
        kind: 'gpt-access-capability',
        capabilityId: 'ARCANOS:CLI',
        capabilityAction: 'status'
      }
    }));
    expect(cliRepoContext).toEqual(expect.objectContaining({
      requiredScope: 'capabilities.run',
      risk: 'privileged',
      requiresConfirmation: true,
      runner: {
        kind: 'gpt-access-capability',
        capabilityId: 'ARCANOS:CLI',
        capabilityAction: 'repoContext'
      }
    }));
  });

  it('requires policy confirmation before ARCANOS:CLI dispatch execution', () => {
    const registry = createGptAccessDispatchRegistry([
      {
        id: 'ARCANOS:CLI',
        description: 'ARCANOS CLI bridge',
        route: 'arcanos-cli',
        actions: ['status']
      }
    ]);
    const plan = resolveRuleBasedDispatchPlan({
      utterance: 'ARCANOS:CLI.status',
      registry
    });

    const decision = evaluateDispatchPolicy({
      plan,
      registry,
      isScopeAllowed: () => true,
      isModuleActionAllowed: () => true
    });

    expect(plan).toEqual(expect.objectContaining({
      action: 'ARCANOS:CLI.status',
      confidence: 1,
      requiresConfirmation: true
    }));
    expect(decision).toEqual(expect.objectContaining({
      status: 'confirmation_required',
      allowed: true,
      requiresConfirmation: true,
      shouldExecute: false,
      reason: 'confirmation_required'
    }));
  });

  it('blocks ARCANOS:CLI dispatch when the capability scope kill switch is disabled', () => {
    const registry = createGptAccessDispatchRegistry([
      {
        id: 'ARCANOS:CLI',
        description: 'ARCANOS CLI bridge',
        route: 'arcanos-cli',
        actions: ['status']
      }
    ]);
    const plan = resolveRuleBasedDispatchPlan({
      utterance: 'ARCANOS:CLI.status',
      registry
    });

    const decision = evaluateDispatchPolicy({
      plan,
      registry,
      isScopeAllowed: () => false,
      isModuleActionAllowed: () => true
    });

    expect(decision).toEqual(expect.objectContaining({
      status: 'blocked',
      allowed: false,
      requiresConfirmation: false,
      shouldExecute: false,
      reason: 'gpt_access_scope_denied',
      code: 'GPT_ACCESS_SCOPE_DENIED'
    }));
  });

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

    await expect(routeOperatorCommandThroughDispatch({
      utterance: 'draft a backend health report'
    })).resolves.toBeNull();

    await expect(routeOperatorCommandThroughDispatch({
      utterance: 'compose a queue status update'
    })).resolves.toBeNull();
  });

  it.each([
    'ask my AI for improvements',
    'suggest improvements to worker reliability',
    'review backend architecture',
    'what should I improve about worker reliability',
    'analyze the queue system design',
    'explain backend architecture',
    'give me your opinion on the backend',
    'analyze backend errors and recommend fixes',
    'explain why workers are failing and suggest improvements',
    'review worker status and tell me what we should improve',
    'what should we do about queue backlog',
    'can you review how to improve backend worker reliability?',
    'could you review backend worker reliability?',
    'how do I design a queue monitor',
    'how should I fix stale workers?',
    'suggest how to fix stale workers',
    'review whether we should recycle stale workers'
  ])('does not intercept advisory prompt "%s"', async (utterance) => {
    await expect(routeOperatorCommandThroughDispatch({ utterance })).resolves.toBeNull();
  });

  it.each([
    ['what is wrong with the backend', 'diagnostics.run'],
    ['analyze backend errors', 'diagnostics.run'],
    ['explain what is wrong with the backend', 'diagnostics.run'],
    ['review worker status', 'workers.status'],
    ['can you review worker status', 'workers.status'],
    ['could you review worker status', 'workers.status'],
    ['check the workers', 'workers.status'],
    ['how do i check the workers', 'workers.status'],
    ['inspect the queue', 'queue.inspect'],
    ['how can i inspect the queue', 'queue.inspect'],
    ['runtime status', 'runtime.inspect'],
    ['health of backend', 'runtime.inspect'],
    ['is the app down', 'runtime.inspect'],
    ['is the queue backed up', 'queue.inspect'],
    ['what should the queue status be', 'queue.inspect'],
    ['what is going on with the queue', 'queue.inspect'],
    ['show queue', 'queue.inspect'],
    ['run diagnostics', 'diagnostics.run']
  ])('routes explicit operator prompt "%s" to %s', async (utterance, action) => {
    const response = await routeOperatorCommandThroughDispatch({ utterance, dryRun: true });

    expect(response).not.toBeNull();
    expect(response?.plan.action).toBe(action);
    expect(response?.policy.shouldExecute).toBe(true);
  });
});
