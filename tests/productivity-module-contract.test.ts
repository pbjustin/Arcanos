import { describe, expect, test } from '@jest/globals';

import ArcanosProductivity from '../src/services/arcanos-productivity.js';
import { PRODUCTIVITY_ACTION_INPUT_SCHEMAS } from '../src/services/productivity/productivitySchemas.js';
import {
  PRODUCTIVITY_ACTIONS,
  PRODUCTIVITY_MODULE_NAME
} from '../src/services/productivity/productivityTypes.js';

const READONLY_ACTIONS = new Set([
  'intent.catalog',
  'intent.resolve',
  'state.current',
  'context.summary',
  'reference.resolve',
  'inbox.list',
  'task.list',
  'project.list',
  'project.health',
  'focus.today',
  'knowledge.find',
  'review.daily',
  'review.weekly'
]);

const publishedProperties = (
  action: keyof typeof PRODUCTIVITY_ACTION_INPUT_SCHEMAS
): Record<string, Record<string, unknown>> =>
  PRODUCTIVITY_ACTION_INPUT_SCHEMAS[action].properties as Record<
    string,
    Record<string, unknown>
  >;

const trimmedStringContract = (maxLength: number) => ({
  type: 'string',
  minLength: 1,
  maxLength,
  pattern: '\\S'
});

describe('ARCANOS:PRODUCTIVITY module contract', () => {
  test('publishes all 24 schema-first actions with fail-closed mutation policy', () => {
    expect(ArcanosProductivity).toMatchObject({
      name: PRODUCTIVITY_MODULE_NAME,
      defaultAction: 'context.summary',
      exposeLegacyRoute: false,
      gptAccessOnly: true
    });
    expect(Object.keys(ArcanosProductivity.actions).sort()).toEqual(
      [...PRODUCTIVITY_ACTIONS].sort()
    );
    expect(Object.keys(ArcanosProductivity.actionMetadata ?? {}).sort()).toEqual(
      [...PRODUCTIVITY_ACTIONS].sort()
    );

    for (const action of PRODUCTIVITY_ACTIONS) {
      const metadata = ArcanosProductivity.actionMetadata?.[action];
      expect(metadata).toEqual(expect.objectContaining({
        description: expect.any(String),
        risk: READONLY_ACTIONS.has(action) ? 'readonly' : 'privileged',
        requiresConfirmation: !READONLY_ACTIONS.has(action),
        idempotent: true,
        inputSchema: PRODUCTIVITY_ACTION_INPUT_SCHEMAS[action]
      }));
      expect(metadata?.inputSchema).toEqual(expect.objectContaining({
        type: 'object',
        additionalProperties: false
      }));
    }
  });

  test('publishes the runtime string limits and non-whitespace constraints', () => {
    expect(publishedProperties('intent.resolve').utterance).toEqual(
      expect.objectContaining(trimmedStringContract(1_000))
    );
    expect(publishedProperties('capture.add').text).toEqual(
      expect.objectContaining(trimmedStringContract(240))
    );
    expect(publishedProperties('capture.add').notes).toEqual(
      expect.objectContaining(trimmedStringContract(20_000))
    );
    expect(publishedProperties('task.complete').task).toEqual(
      expect.objectContaining(trimmedStringContract(240))
    );
    expect(publishedProperties('knowledge.find').query).toEqual(
      expect.objectContaining(trimmedStringContract(500))
    );
    expect(publishedProperties('knowledge.store').content).toEqual(
      expect.objectContaining(trimmedStringContract(100_000))
    );

    const mutationActions = [
      'capture.add',
      'inbox.process',
      'task.create',
      'task.complete',
      'task.defer',
      'task.transition',
      'project.create',
      'project.advance',
      'project.transition',
      'knowledge.store',
      'review.record'
    ] as const;
    for (const action of mutationActions) {
      expect(publishedProperties(action).idempotencyKey).toEqual(
        expect.objectContaining(trimmedStringContract(240))
      );
    }

    expect(publishedProperties('review.record').completed).toEqual(
      expect.objectContaining({
        type: 'array',
        items: expect.objectContaining(trimmedStringContract(240))
      })
    );
  });

  test('fails closed when a handler is called without trusted GPT Access context', async () => {
    await expect(
      ArcanosProductivity.actions['state.current']?.({})
    ).resolves.toEqual({
      ok: false,
      action: 'state.current',
      persisted: false,
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Productivity requires a trusted GPT Access principal and workspace.',
        recoverable: true,
        recommendedAction: 'CHECK_CONFIGURATION'
      }
    });
  });

  test('executes a read-only action with trusted GPT Access context', async () => {
    await expect(
      ArcanosProductivity.actions['intent.resolve']?.(
        { utterance: "I'm overwhelmed." },
        {
          source: 'gpt-access',
          principalId: 'operator:primary',
          workspaceId: 'personal',
          actorKey: 'actor:test',
          requestId: 'request:test',
          traceId: 'trace:test'
        }
      )
    ).resolves.toMatchObject({
      ok: true,
      action: 'intent.resolve',
      persisted: false,
      data: {
        status: 'resolved',
        verb: 'focus',
        recommendedActions: ['focus.today']
      }
    });
  });
});
