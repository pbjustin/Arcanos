import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';

import {
  INTENT_CLARIFICATION_REQUIRED,
  createCapabilityRegistry,
  createGptAccessDispatchRegistry,
  evaluateDispatchPolicy,
  readDispatchConfirmationTokenField,
  resolveDispatchPlan
} from '../src/dispatcher/naturalLanguage/index.js';

const savedDispatchMode = process.env.GPT_ACCESS_NL_DISPATCH_MODE;

describe('natural-language dispatcher', () => {
  beforeEach(() => {
    process.env.GPT_ACCESS_NL_DISPATCH_MODE = 'rules';
  });

  afterEach(() => {
    if (savedDispatchMode === undefined) {
      delete process.env.GPT_ACCESS_NL_DISPATCH_MODE;
    } else {
      process.env.GPT_ACCESS_NL_DISPATCH_MODE = savedDispatchMode;
    }
  });

  it.each([
    ['check the workers', 'workers.status'],
    ['check workers', 'workers.status'],
    ['how do i check the workers', 'workers.status'],
    ['are workers alive', 'workers.status'],
    ['inspect the queue', 'queue.inspect'],
    ['how can i inspect the queue', 'queue.inspect'],
    ['what should the queue status be', 'queue.inspect'],
    ['is the queue backed up', 'queue.inspect'],
    ['show queue', 'queue.inspect'],
    ['runtime status', 'runtime.inspect'],
    ['health of backend', 'runtime.inspect'],
    ['what is wrong with the backend', 'diagnostics.run'],
    ['analyze backend errors', 'diagnostics.run'],
    ['explain what is wrong with the backend', 'diagnostics.run'],
    ['review worker status', 'workers.status'],
    ['what is going on with the queue', 'queue.inspect'],
    ['run diagnostics', 'diagnostics.run'],
    ['run full health check', 'diagnostics.run']
  ])('resolves "%s" to %s', async (utterance, action) => {
    const registry = createGptAccessDispatchRegistry();

    const plan = await resolveDispatchPlan({ utterance, registry });

    expect(plan.action).toBe(action);
    expect(plan.confidence).toBeGreaterThanOrEqual(0.8);
    expect(plan.source).toBe('rules');
  });

  it('returns clarification for unknown utterances', async () => {
    const registry = createGptAccessDispatchRegistry();

    const plan = await resolveDispatchPlan({
      utterance: 'please do the vague thing',
      registry
    });

    expect(plan.action).toBe(INTENT_CLARIFICATION_REQUIRED);
    expect(plan.requiresConfirmation).toBe(false);
  });

  it.each([
    'ask my AI for improvements',
    'suggest improvements to worker reliability',
    'review backend architecture',
    'what should I improve about worker reliability',
    'how do I design a queue monitor'
  ])('returns clarification for advisory prompt "%s"', async (utterance) => {
    const registry = createGptAccessDispatchRegistry();

    const plan = await resolveDispatchPlan({ utterance, registry });

    expect(plan.action).toBe(INTENT_CLARIFICATION_REQUIRED);
  });

  it('blocks prohibited registered actions before execution', async () => {
    const registry = createCapabilityRegistry([
      {
        action: 'shell.run',
        risk: 'destructive',
        requiredScope: 'capabilities.run',
        runner: {
          kind: 'gpt-access-capability',
          capabilityId: 'SHELL',
          capabilityAction: 'run'
        }
      }
    ]);
    const plan = await resolveDispatchPlan({ utterance: 'shell.run', registry });

    const policy = evaluateDispatchPolicy({ plan, registry });

    expect(policy.allowed).toBe(false);
    expect(policy.code).toBe('DISPATCH_ACTION_PROHIBITED');
  });

  it.each([
    'self_heal.status',
    'show_sql_stats',
    'fetch_url_content'
  ])('allows registered read-only action name %s through policy', async (action) => {
    const registry = createCapabilityRegistry([
      {
        action,
        risk: 'readonly',
        runner: {
          kind: 'gpt-access-mcp',
          tool: action
        }
      }
    ]);
    const plan = await resolveDispatchPlan({ utterance: action, registry });

    const policy = evaluateDispatchPolicy({ plan, registry });

    expect(policy.allowed).toBe(true);
    expect(policy.status).toBe('allowed');
  });

  it.each([
    'raw_sql.query',
    'self_heal.execute'
  ])('blocks prohibited action name %s before execution', async (action) => {
    const registry = createCapabilityRegistry([
      {
        action,
        risk: 'privileged',
        runner: {
          kind: 'gpt-access-capability',
          capabilityId: 'ARCANOS:CORE',
          capabilityAction: 'query'
        }
      }
    ]);
    const plan = await resolveDispatchPlan({ utterance: action, registry });

    const policy = evaluateDispatchPolicy({ plan, registry });

    expect(policy.allowed).toBe(false);
    expect(policy.code).toBe('DISPATCH_ACTION_PROHIBITED');
  });

  it('normalizes token-prefixed confirmation values before validating the challenge token', () => {
    const prefixedChallengeId = ['tok', 'en: ', 'challenge-id'].join('');

    expect(readDispatchConfirmationTokenField(prefixedChallengeId)).toEqual({
      ok: true,
      confirmationChallengeId: 'challenge-id'
    });
  });

  it('requires confirmation for registered GPT Access capability actions', async () => {
    const registry = createGptAccessDispatchRegistry([
      {
        id: 'ARCANOS:CORE',
        description: 'Core runtime capability',
        route: 'core',
        actions: ['query']
      }
    ]);
    const plan = await resolveDispatchPlan({ utterance: 'ARCANOS:CORE.query', registry });

    const policy = evaluateDispatchPolicy({
      plan,
      registry,
      isScopeAllowed: () => true,
      isModuleActionAllowed: () => true
    });

    expect(plan.action).toBe('ARCANOS:CORE.query');
    expect(policy.allowed).toBe(true);
    expect(policy.status).toBe('confirmation_required');
    expect(policy.requiresConfirmation).toBe(true);
  });

  it.each([
    ['readonly', 'workers.status', 0.54, 'clarification_required', 'dispatch_confidence_below_threshold'],
    ['readonly', 'workers.status', 0.55, 'clarification_required', 'dispatch_confidence_in_clarification_band'],
    ['readonly', 'workers.status', 0.64, 'clarification_required', 'dispatch_confidence_in_clarification_band'],
    ['readonly', 'workers.status', 0.65, 'allowed', 'policy_allowed'],
    ['readonly', 'workers.status', 0.7, 'allowed', 'policy_allowed'],
    ['privileged', 'workers.recover', 0.69, 'clarification_required', 'dispatch_confidence_below_threshold'],
    ['privileged', 'workers.recover', 0.7, 'clarification_required', 'dispatch_confidence_in_clarification_band'],
    ['privileged', 'workers.recover', 0.77, 'clarification_required', 'dispatch_confidence_in_clarification_band'],
    ['privileged', 'workers.recover', 0.78, 'confirmation_required', 'confirmation_required'],
    ['destructive', 'data.purge', 0.89, 'clarification_required', 'dispatch_confidence_below_threshold'],
    ['destructive', 'data.purge', 0.9, 'blocked', 'dispatch_action_prohibited']
  ] as const)('applies %s policy threshold at %s confidence', (risk, action, confidence, status, reason) => {
    const registry = createCapabilityRegistry([
      {
        action,
        risk,
        runner: risk === 'readonly'
          ? {
              kind: 'gpt-access-mcp',
              tool: action
            }
          : risk === 'privileged'
            ? {
                kind: 'gpt-access-worker-recovery',
                mode: 'recover'
              }
            : {
                kind: 'gpt-access-capability',
                capabilityId: 'DATA',
                capabilityAction: 'purge'
              }
      }
    ]);

    const policy = evaluateDispatchPolicy({
      plan: {
        action,
        payload: {},
        confidence,
        source: 'llm',
        requiresConfirmation: false
      },
      registry,
      isScopeAllowed: () => true,
      isModuleActionAllowed: () => true
    });

    expect(policy.status).toBe(status);
    expect(policy.reason).toBe(reason);
    expect(policy.shouldExecute).toBe(status === 'allowed');
  });
});
