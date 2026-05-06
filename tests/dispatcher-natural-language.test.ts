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
    ['are workers alive', 'workers.status'],
    ['inspect the queue', 'queue.inspect'],
    ['is the queue backed up', 'queue.inspect'],
    ['show queue', 'queue.inspect'],
    ['runtime status', 'runtime.inspect'],
    ['health of backend', 'runtime.inspect'],
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
    'review backend architecture'
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

  it('allows readonly dispatch at 0.70 confidence', () => {
    const registry = createCapabilityRegistry([
      {
        action: 'workers.status',
        risk: 'readonly',
        runner: {
          kind: 'gpt-access-mcp',
          tool: 'workers.status'
        }
      }
    ]);

    const policy = evaluateDispatchPolicy({
      plan: {
        action: 'workers.status',
        payload: {},
        confidence: 0.7,
        source: 'llm',
        requiresConfirmation: false
      },
      registry
    });

    expect(policy.status).toBe('allowed');
    expect(policy.shouldExecute).toBe(true);
  });

  it('clarifies privileged dispatch at 0.70 confidence without executing', () => {
    const registry = createCapabilityRegistry([
      {
        action: 'workers.recover',
        risk: 'privileged',
        runner: {
          kind: 'gpt-access-worker-recovery',
          mode: 'recover'
        }
      }
    ]);

    const policy = evaluateDispatchPolicy({
      plan: {
        action: 'workers.recover',
        payload: {},
        confidence: 0.7,
        source: 'llm',
        requiresConfirmation: false
      },
      registry
    });

    expect(policy.status).toBe('clarification_required');
    expect(policy.shouldExecute).toBe(false);
  });

  it('does not execute destructive dispatch below 0.90 confidence', () => {
    const registry = createCapabilityRegistry([
      {
        action: 'data.purge',
        risk: 'destructive',
        runner: {
          kind: 'gpt-access-capability',
          capabilityId: 'DATA',
          capabilityAction: 'purge'
        }
      }
    ]);

    const policy = evaluateDispatchPolicy({
      plan: {
        action: 'data.purge',
        payload: {},
        confidence: 0.89,
        source: 'llm',
        requiresConfirmation: false
      },
      registry,
      isScopeAllowed: () => true,
      isModuleActionAllowed: () => true
    });

    expect(policy.allowed).toBe(false);
    expect(policy.shouldExecute).toBe(false);
  });
});
