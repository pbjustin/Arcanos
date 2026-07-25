import { createProductivityRepository } from '@core/db/repositories/productivityRepository.js';
import { logger } from '@platform/logging/structuredLogging.js';

import type {
  ModuleActionMetadata,
  ModuleDef,
  ModuleHandlerContext
} from './moduleLoader.js';
import { PRODUCTIVITY_ACTION_INPUT_SCHEMAS } from './productivity/productivitySchemas.js';
import { ProductivityService } from './productivity/productivityService.js';
import {
  PRODUCTIVITY_ACTIONS,
  PRODUCTIVITY_MODULE_NAME,
  ProductivityError,
  type ProductivityAction,
  type ProductivityScope
} from './productivity/productivityTypes.js';

const READONLY_ACTIONS = new Set<ProductivityAction>([
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

const ACTION_DESCRIPTIONS: Record<ProductivityAction, string> = {
  'intent.catalog': 'List the stable conversational productivity verbs.',
  'intent.resolve': 'Conservatively classify a natural-language productivity request without executing it.',
  'state.current': 'Read the canonical current productivity projection.',
  'context.summary': 'Summarize current tasks, projects, focus, reviews, and warnings.',
  'reference.resolve': 'Resolve a scoped task or project reference without mutating state.',
  'inbox.list': 'List unclarified inbox tasks.',
  'task.list': 'List scoped tasks with optional status and project filters.',
  'project.list': 'List scoped projects with an optional status filter.',
  'project.health': 'Evaluate deterministic project health and next-action coverage.',
  'focus.today': 'Rank today’s focus candidates from canonical task and project evidence.',
  'knowledge.find': 'Find scoped durable notes.',
  'review.daily': 'Build a daily review checklist and evidence snapshot.',
  'review.weekly': 'Build a weekly review checklist and evidence snapshot.',
  'capture.add': 'Capture an unclarified item in the productivity inbox.',
  'inbox.process': 'Clarify an inbox item into a canonical task state.',
  'task.create': 'Create a canonical productivity task.',
  'task.complete': 'Complete one resolved task.',
  'task.defer': 'Defer one resolved task until an ISO-8601 timestamp.',
  'task.transition': 'Move one resolved task through its canonical lifecycle.',
  'project.create': 'Create a finite-outcome project.',
  'project.advance': 'Create a concrete next action for one project.',
  'project.transition': 'Move one resolved project through its canonical lifecycle.',
  'knowledge.store': 'Store a durable scoped note.',
  'review.record': 'Persist a completed daily or weekly review.'
};

const actionMetadata = Object.fromEntries(
  PRODUCTIVITY_ACTIONS.map((action): [ProductivityAction, ModuleActionMetadata] => {
    const readonly = READONLY_ACTIONS.has(action);
    return [
      action,
      {
        description: ACTION_DESCRIPTIONS[action],
        risk: readonly ? 'readonly' : 'privileged',
        requiresConfirmation: !readonly,
        inputSchema: PRODUCTIVITY_ACTION_INPUT_SCHEMAS[action],
        idempotent: true
      }
    ];
  })
) as Record<ProductivityAction, ModuleActionMetadata>;

const productivityService = new ProductivityService(createProductivityRepository());

function isValidScopeIdentifier(value: unknown): value is string {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/u.test(value);
}

function requireScope(context: ModuleHandlerContext | undefined): ProductivityScope {
  if (
    context?.source !== 'gpt-access'
    || !isValidScopeIdentifier(context.principalId)
    || !isValidScopeIdentifier(context.workspaceId)
  ) {
    throw new ProductivityError({
      code: 'PERMISSION_DENIED',
      message: 'Productivity requires a trusted GPT Access principal and workspace.',
      recoverable: true,
      recommendedAction: 'CHECK_CONFIGURATION'
    });
  }

  return {
    principalId: context.principalId,
    workspaceId: context.workspaceId,
    actorKey: typeof context.actorKey === 'string' ? context.actorKey : undefined,
    requestId: context.requestId,
    traceId: context.traceId ?? undefined
  };
}

function toErrorEnvelope(action: ProductivityAction, error: unknown) {
  if (error instanceof ProductivityError) {
    return {
      ok: false,
      action,
      persisted: false,
      error: {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
        recommendedAction: error.recommendedAction,
        ...(error.details ? { details: error.details } : {})
      }
    };
  }

  const message = error instanceof Error ? error.message : '';
  const dependencyUnavailable =
    /database (?:not configured|pool not available)|dependency unavailable/iu.test(message);
  logger.error('productivity.action.failed', {
    module: PRODUCTIVITY_MODULE_NAME,
    action,
    errorCode: dependencyUnavailable ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR'
  });

  return {
    ok: false,
    action,
    persisted: false,
    error: {
      code: dependencyUnavailable ? 'DEPENDENCY_UNAVAILABLE' : 'INTERNAL_ERROR',
      message: dependencyUnavailable
        ? 'Productivity storage is temporarily unavailable.'
        : 'The productivity action could not be completed safely.',
      recoverable: dependencyUnavailable,
      recommendedAction: dependencyUnavailable ? 'RETRY_LATER' : 'CONTACT_OPERATOR'
    }
  };
}

async function executeProductivityAction(
  action: ProductivityAction,
  payload: unknown,
  context?: ModuleHandlerContext
) {
  try {
    const scope = requireScope(context);
    return await productivityService.execute(action, payload, {
      scope,
      idempotencyKey: context?.idempotencyKey
    });
  } catch (error) {
    return toErrorEnvelope(action, error);
  }
}

const actions = Object.fromEntries(
  PRODUCTIVITY_ACTIONS.map((action) => [
    action,
    (payload: unknown, context?: ModuleHandlerContext) =>
      executeProductivityAction(action, payload, context)
  ])
) as ModuleDef['actions'];

export const ArcanosProductivity: ModuleDef = {
  name: PRODUCTIVITY_MODULE_NAME,
  description: 'Protected conversational productivity capabilities backed by canonical PostgreSQL state.',
  defaultAction: 'context.summary',
  defaultTimeoutMs: 30_000,
  exposeLegacyRoute: false,
  gptAccessOnly: true,
  actions,
  actionMetadata
};

export default ArcanosProductivity;
