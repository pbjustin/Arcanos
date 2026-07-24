import { randomUUID } from 'node:crypto';
import { type z } from 'zod';

import {
  captureAddInputSchema,
  emptyProductivityInputSchema,
  inboxListInputSchema,
  inboxProcessInputSchema,
  intentResolveInputSchema,
  knowledgeFindInputSchema,
  knowledgeStoreInputSchema,
  projectAdvanceInputSchema,
  projectCreateInputSchema,
  projectHealthInputSchema,
  projectListInputSchema,
  projectTransitionInputSchema,
  referenceResolveInputSchema,
  reviewReadInputSchema,
  reviewRecordInputSchema,
  taskCompleteInputSchema,
  taskCreateInputSchema,
  taskDeferInputSchema,
  taskListInputSchema,
  taskTransitionInputSchema
} from './productivitySchemas.js';
import {
  PRODUCTIVITY_ACTIONS,
  type ProductivityAction,
  type ProductivityCommandContext,
  ProductivityError,
  type ProductivityMutationResult,
  type ProductivityProject,
  type ProductivityProjectAdvanceResult,
  type ProductivityReferenceType,
  type ProductivityRepository,
  type ProductivityReview,
  type ProductivityReviewKind,
  type ProductivityScope,
  type ProductivityTask
} from './productivityTypes.js';

const FORBIDDEN_TENANCY_KEYS = new Set([
  'ownerid',
  'principalid',
  'workspaceid'
]);

const REFERENCE_CANDIDATE_LIMIT = 8;

type ProductivityExecutionContext = {
  scope: ProductivityScope;
  idempotencyKey?: string;
};

type ProductivitySuccessEnvelope = {
  ok: true;
  action: ProductivityAction;
  persisted: boolean;
  replayed?: boolean;
  changed?: boolean;
  effect?: {
    outcome: string;
    message: string;
    entities: Array<{ type: 'task' | 'project' | 'note' | 'review'; id: string }>;
  };
  data: unknown;
};

type ProjectHealth = {
  project: ProductivityProject;
  health: 'healthy' | 'at_risk' | 'blocked' | 'stalled' | 'paused' | 'complete' | 'archived';
  missingNextAction: boolean;
  reasonCodes: string[];
  openTaskCount: number;
  blockedTaskCount: number;
};

type ReferenceResolution =
  | { status: 'resolved'; entity: ProductivityTask | ProductivityProject }
  | {
      status: 'ambiguous';
      candidates: Array<ProductivityTask | ProductivityProject>;
    };

function normalizePayloadKey(key: string): string {
  return key.toLowerCase().replace(/[\s._-]+/gu, '');
}

function findForbiddenTenancyKey(value: unknown): string | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const nested = findForbiddenTenancyKey(entry);
      if (nested) return nested;
    }
    return null;
  }

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_TENANCY_KEYS.has(normalizePayloadKey(key))) {
      return key;
    }
    const nested = findForbiddenTenancyKey(entry);
    if (nested) return nested;
  }
  return null;
}

function parseInput<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  payload: unknown
): z.infer<TSchema> {
  const parsed = schema.safeParse(payload ?? {});
  if (parsed.success) {
    return parsed.data;
  }

  throw new ProductivityError({
    code: 'VALIDATION_FAILED',
    message: 'The productivity action payload is invalid.',
    recoverable: true,
    recommendedAction: 'FIX_INPUT',
    details: {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        code: issue.code,
        message: issue.message
      }))
    }
  });
}

function toIsoTimestamp(value: string | null | undefined): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

function toUtcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function startOfUtcDay(value: Date): number {
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function daysFromNow(timestamp: string, now: Date): number {
  return Math.floor((new Date(timestamp).getTime() - startOfUtcDay(now)) / 86_400_000);
}

function readEnvelope(action: ProductivityAction, data: unknown): ProductivitySuccessEnvelope {
  return {
    ok: true,
    action,
    persisted: false,
    data
  };
}

function mutationEnvelope<T>(
  action: ProductivityAction,
  result: ProductivityMutationResult<T>,
  input: {
    outcome: string;
    message: string;
    entities: Array<{ type: 'task' | 'project' | 'note' | 'review'; id: string }>;
    data: unknown;
  }
): ProductivitySuccessEnvelope {
  return {
    ok: true,
    action,
    persisted: true,
    replayed: result.replayed,
    changed: result.changed,
    effect: {
      outcome: input.outcome,
      message: input.message,
      entities: input.entities
    },
    data: input.data
  };
}

function commandContext(
  action: ProductivityAction,
  inputIdempotencyKey: string | undefined,
  execution: ProductivityExecutionContext,
  semanticRequest?: unknown
): ProductivityCommandContext {
  if (
    execution.idempotencyKey
    && inputIdempotencyKey
    && execution.idempotencyKey !== inputIdempotencyKey
  ) {
    throw new ProductivityError({
      code: 'IDEMPOTENCY_CONFLICT',
      message: 'idempotencyKey must match the Idempotency-Key header when both are supplied.',
      recoverable: true,
      recommendedAction: 'CHANGE_IDEMPOTENCY_KEY'
    });
  }

  return {
    action,
    idempotencyKey:
      execution.idempotencyKey
      ?? inputIdempotencyKey
      ?? execution.scope.requestId
      ?? randomUUID(),
    requestId: execution.scope.requestId,
    traceId: execution.scope.traceId,
    actorKey: execution.scope.actorKey,
    ...(semanticRequest === undefined ? {} : { semanticRequest })
  };
}

function semanticCommandInput<T extends object>(input: T): Record<string, unknown> {
  const request = { ...input } as Record<string, unknown>;
  delete request.idempotencyKey;
  return request;
}

function normalizeReference(value: string): string {
  return value.trim().toLocaleLowerCase('en-US');
}

function referenceTitle(entity: ProductivityTask | ProductivityProject): string {
  return entity.title;
}

function filterReferenceCandidates(
  reference: string,
  candidates: Array<ProductivityTask | ProductivityProject>
): Array<ProductivityTask | ProductivityProject> {
  const normalized = normalizeReference(reference);
  const rank = (candidate: ProductivityTask | ProductivityProject): number => {
    const title = normalizeReference(referenceTitle(candidate));
    if (candidate.id.toLowerCase() === normalized) return 0;
    if (title === normalized) return 1;
    if (title.startsWith(normalized)) return 2;
    return 3;
  };

  return candidates
    .filter((candidate) => (
      candidate.id.toLowerCase() === normalized
      || normalizeReference(referenceTitle(candidate)).includes(normalized)
    ))
    .sort((left, right) => (
      rank(left) - rank(right)
      || right.updatedAt.localeCompare(left.updatedAt)
      || left.id.localeCompare(right.id)
    ));
}

function selectReferenceResolution(
  reference: string,
  candidates: Array<ProductivityTask | ProductivityProject>
): ReferenceResolution | null {
  if (candidates.length === 0) {
    return null;
  }

  const normalized = normalizeReference(reference);
  const exactIdMatches = candidates.filter((candidate) => candidate.id.toLowerCase() === normalized);
  if (exactIdMatches.length === 1) {
    return { status: 'resolved', entity: exactIdMatches[0] };
  }

  const exactTitleMatches = candidates.filter(
    (candidate) => normalizeReference(referenceTitle(candidate)) === normalized
  );
  if (exactTitleMatches.length === 1) {
    return { status: 'resolved', entity: exactTitleMatches[0] };
  }
  if (exactTitleMatches.length > 1) {
    return { status: 'ambiguous', candidates: exactTitleMatches };
  }
  if (candidates.length === 1) {
    return { status: 'resolved', entity: candidates[0] };
  }

  return { status: 'ambiguous', candidates };
}

function isOpenTask(item: ProductivityTask): boolean {
  return item.status !== 'done' && item.status !== 'cancelled';
}

function indexTasksByProject(
  tasks: ProductivityTask[]
): Map<string, ProductivityTask[]> {
  const tasksByProject = new Map<string, ProductivityTask[]>();
  for (const task of tasks) {
    if (!task.projectId) {
      continue;
    }
    const linkedTasks = tasksByProject.get(task.projectId);
    if (linkedTasks) {
      linkedTasks.push(task);
    } else {
      tasksByProject.set(task.projectId, [task]);
    }
  }
  return tasksByProject;
}

function calculateProjectHealth(
  project: ProductivityProject,
  linkedTasks: ProductivityTask[],
  now: Date
): ProjectHealth {
  const openTasks = linkedTasks.filter(isOpenTask);
  const nextTasks = openTasks.filter(
    (item) => item.status === 'next' || item.status === 'scheduled'
  );
  const blockedTasks = openTasks.filter((item) => item.status === 'waiting');
  const overdueTasks = openTasks.filter(
    (item) => item.dueAt !== null && new Date(item.dueAt).getTime() < now.getTime()
  );
  const reasonCodes: string[] = [];
  let health: ProjectHealth['health'];

  if (project.status === 'archived') {
    health = 'archived';
  } else if (project.status === 'completed') {
    health = 'complete';
  } else if (project.status === 'on_hold') {
    health = 'paused';
  } else if (project.status === 'blocked') {
    health = 'blocked';
    reasonCodes.push('project_marked_blocked');
  } else if (nextTasks.length === 0) {
    health = 'stalled';
    reasonCodes.push('missing_next_action');
  } else if (
    overdueTasks.length > 0
    || (project.dueAt !== null && new Date(project.dueAt).getTime() < now.getTime())
  ) {
    health = 'at_risk';
    if (overdueTasks.length > 0) reasonCodes.push('overdue_tasks');
    if (project.dueAt !== null && new Date(project.dueAt).getTime() < now.getTime()) {
      reasonCodes.push('project_overdue');
    }
  } else {
    health = 'healthy';
  }

  if (blockedTasks.length > 0) {
    reasonCodes.push('waiting_tasks');
  }

  return {
    project,
    health,
    missingNextAction:
      (project.status === 'active' || project.status === 'blocked') && nextTasks.length === 0,
    reasonCodes,
    openTaskCount: openTasks.length,
    blockedTaskCount: blockedTasks.length
  };
}

function calculateFocus(
  tasks: ProductivityTask[],
  projects: ProductivityProject[],
  now: Date
) {
  const projectsById = new Map(projects.map((project) => [project.id, project]));
  const candidates = tasks
    .filter((item) => {
      if (item.status !== 'next' && item.status !== 'scheduled') {
        return false;
      }
      const project = item.projectId ? projectsById.get(item.projectId) : undefined;
      if (project?.status === 'completed' || project?.status === 'archived') {
        return false;
      }
      return item.deferUntil === null || new Date(item.deferUntil).getTime() <= now.getTime();
    })
    .map((item) => {
      const reasonCodes: string[] = [];
      let score = item.priority * 20;
      const project = item.projectId ? projectsById.get(item.projectId) : undefined;

      if (item.priority >= 3) {
        reasonCodes.push('high_priority');
      }
      if (item.dueAt) {
        const dueAtMs = new Date(item.dueAt).getTime();
        const days = daysFromNow(item.dueAt, now);
        if (dueAtMs < now.getTime()) {
          score += 100;
          reasonCodes.push('overdue');
        } else if (days === 0) {
          score += 70;
          reasonCodes.push('due_today');
        } else if (days <= 3) {
          score += 40;
          reasonCodes.push('due_soon');
        }
      }
      if (project?.status === 'active') {
        score += 15;
        reasonCodes.push('active_project');
      }
      if (project?.dueAt) {
        const projectDueAtMs = new Date(project.dueAt).getTime();
        const projectDays = daysFromNow(project.dueAt, now);
        if (projectDueAtMs < now.getTime()) {
          score += 40;
          reasonCodes.push('project_overdue');
        } else if (projectDays <= 3) {
          score += 20;
          reasonCodes.push('project_due_soon');
        }
      }

      return {
        item,
        project: project ?? null,
        score,
        reasonCodes
      };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      const leftDue = left.item.dueAt ? new Date(left.item.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      const rightDue = right.item.dueAt ? new Date(right.item.dueAt).getTime() : Number.MAX_SAFE_INTEGER;
      if (leftDue !== rightDue) return leftDue - rightDue;
      return left.item.createdAt.localeCompare(right.item.createdAt);
    });

  return {
    generatedAt: now.toISOString(),
    recommended: candidates.slice(0, 3),
    candidateCount: candidates.length
  };
}

function latestReview(
  reviews: ProductivityReview[],
  kind: ProductivityReviewKind
): ProductivityReview | null {
  return reviews
    .filter((review) => review.kind === kind)
    .sort((left, right) => right.reviewDate.localeCompare(left.reviewDate))[0] ?? null;
}

function calculateReviewStatus(reviews: ProductivityReview[], now: Date) {
  const daily = latestReview(reviews, 'daily');
  const weekly = latestReview(reviews, 'weekly');
  const today = toUtcDate(now);
  const weeklyCutoff = new Date(now.getTime() - (6 * 86_400_000));

  return {
    daily: {
      due: daily?.reviewDate !== today,
      lastRecorded: daily
    },
    weekly: {
      due: !weekly || new Date(`${weekly.reviewDate}T00:00:00.000Z`) < weeklyCutoff,
      lastRecorded: weekly
    }
  };
}

function resolveIntent(utterance: string) {
  const normalized = utterance
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();

  if (
    /\b(?:did not|didn t|do not|don t|have not|haven t|has not|hasn t|not|never)(?: [a-z0-9]+){0,4} (?:finish(?:ed)?|complete(?:d)?|done)\b/u
      .test(normalized)
    || /\b(?:do not|don t|never)(?: [a-z0-9]+){0,4} (?:defer|postpone|capture|remember|note|save|create|add|process|clean|clear|advance|move|store|record)\b/u
      .test(normalized)
  ) {
    return {
      status: 'unknown',
      verb: null,
      recommendedActions: [],
      confidence: 0
    };
  }

  const matches: Array<{
    verb: string;
    actions: ProductivityAction[];
    confidence: number;
    test: RegExp;
  }> = [
    { verb: 'complete_task', actions: ['task.complete'], confidence: 0.96, test: /\b(?:i )?(?:finished|completed|done with)\b/u },
    { verb: 'defer_task', actions: ['task.defer'], confidence: 0.94, test: /\b(?:not today|later|defer|postpone|push back)\b/u },
    { verb: 'focus', actions: ['focus.today'], confidence: 0.96, test: /\b(?:overwhelmed|what should i do|what matters|focus today)\b/u },
    { verb: 'context', actions: ['context.summary'], confidence: 0.96, test: /\b(?:what s going on|where am i|current state|catch me up)\b/u },
    { verb: 'plan_day', actions: ['state.current', 'focus.today'], confidence: 0.95, test: /\b(?:plan my day|plan today|organize my day)\b/u },
    { verb: 'process_inbox', actions: ['inbox.list', 'inbox.process'], confidence: 0.94, test: /\b(?:process|clean|clear)\b.*\binbox\b/u },
    { verb: 'advance_project', actions: ['project.health', 'project.advance'], confidence: 0.92, test: /\b(?:advance|move forward|next action)\b.*\bproject\b/u },
    { verb: 'daily_review', actions: ['review.daily'], confidence: 0.95, test: /\bdaily review\b/u },
    { verb: 'weekly_review', actions: ['review.weekly'], confidence: 0.95, test: /\bweekly review\b/u },
    { verb: 'create_task', actions: ['task.create'], confidence: 0.9, test: /\b(?:i need to|remind me to|create a task|add a task)\b/u },
    { verb: 'capture', actions: ['capture.add'], confidence: 0.9, test: /\b(?:remember this|capture this|note this|save this)\b/u },
    { verb: 'store_knowledge', actions: ['knowledge.store'], confidence: 0.88, test: /\b(?:remember how|store this knowledge|save this note)\b/u }
  ];

  const candidates = matches
    .filter((entry) => entry.test.test(normalized))
    .sort((left, right) => right.confidence - left.confidence);
  const top = candidates[0];
  const second = candidates[1];

  if (!top || (second && top.confidence - second.confidence < 0.05)) {
    return {
      status: 'unknown',
      verb: null,
      recommendedActions: [],
      confidence: top?.confidence ?? 0
    };
  }

  return {
    status: 'resolved',
    verb: top.verb,
    recommendedActions: top.actions,
    confidence: top.confidence
  };
}

export class ProductivityService {
  constructor(
    private readonly repository: ProductivityRepository,
    private readonly now: () => Date = () => new Date()
  ) {}

  async execute(
    action: ProductivityAction,
    payload: unknown,
    execution: ProductivityExecutionContext
  ): Promise<ProductivitySuccessEnvelope> {
    const forbiddenKey = findForbiddenTenancyKey(payload);
    if (forbiddenKey) {
      throw new ProductivityError({
        code: 'PERMISSION_DENIED',
        message: 'Productivity tenancy is derived from authenticated server context.',
        recoverable: true,
        recommendedAction: 'FIX_INPUT',
        details: { forbiddenField: forbiddenKey }
      });
    }

    switch (action) {
      case 'intent.catalog':
        parseInput(emptyProductivityInputSchema, payload);
        return readEnvelope(action, {
          verbs: [
            'capture',
            'create_task',
            'complete_task',
            'defer_task',
            'focus',
            'context',
            'plan_day',
            'process_inbox',
            'advance_project',
            'daily_review',
            'weekly_review',
            'store_knowledge'
          ],
          actions: PRODUCTIVITY_ACTIONS
        });
      case 'intent.resolve': {
        const input = parseInput(intentResolveInputSchema, payload);
        return readEnvelope(action, resolveIntent(input.utterance));
      }
      case 'state.current': {
        parseInput(emptyProductivityInputSchema, payload);
        return readEnvelope(action, await this.buildCurrentState(execution.scope));
      }
      case 'context.summary': {
        parseInput(emptyProductivityInputSchema, payload);
        const state = await this.buildCurrentState(execution.scope);
        return readEnvelope(action, {
          generatedAt: state.generatedAt,
          summary: state.summary,
          warnings: state.warnings,
          focus: state.focus.recommended
        });
      }
      case 'reference.resolve': {
        const input = parseInput(referenceResolveInputSchema, payload);
        const resolution = await this.resolveReference(
          execution.scope,
          input.entityType,
          input.reference
        );
        return readEnvelope(action, this.publicReferenceResolution(input.entityType, resolution));
      }
      case 'inbox.list': {
        const input = parseInput(inboxListInputSchema, payload);
        const items = await this.repository.listTasks(execution.scope, {
          status: 'inbox',
          limit: input.limit
        });
        return readEnvelope(action, { count: items.length, items });
      }
      case 'task.list': {
        const input = parseInput(taskListInputSchema, payload);
        const items = await this.repository.listTasks(execution.scope, input);
        return readEnvelope(action, { count: items.length, items });
      }
      case 'project.list': {
        const input = parseInput(projectListInputSchema, payload);
        const items = await this.repository.listProjects(execution.scope, input);
        return readEnvelope(action, { count: items.length, items });
      }
      case 'project.health': {
        const input = parseInput(projectHealthInputSchema, payload);
        const snapshot = await this.repository.getCurrentStateSnapshot(execution.scope);
        let projects = snapshot.projects;
        if (input.project) {
          const resolution = selectReferenceResolution(
            input.project,
            filterReferenceCandidates(input.project, projects)
          );
          if (!resolution) {
            throw new ProductivityError({
              code: 'NOT_FOUND',
              message: 'Project not found.',
              recoverable: true,
              recommendedAction: 'ASK_USER'
            });
          }
          if (resolution.status === 'ambiguous') {
            throw this.ambiguousReferenceError(
              'project',
              resolution.candidates.slice(0, REFERENCE_CANDIDATE_LIMIT)
            );
          }
          projects = [resolution.entity as ProductivityProject];
        }
        const tasksByProject = indexTasksByProject(snapshot.tasks);
        const items = projects.map((project) =>
          calculateProjectHealth(
            project,
            tasksByProject.get(project.id) ?? [],
            this.now()
          )
        );
        return readEnvelope(action, { count: items.length, items });
      }
      case 'focus.today': {
        parseInput(emptyProductivityInputSchema, payload);
        const snapshot = await this.repository.getCurrentStateSnapshot(execution.scope);
        return readEnvelope(
          action,
          calculateFocus(snapshot.tasks, snapshot.projects, this.now())
        );
      }
      case 'knowledge.find': {
        const input = parseInput(knowledgeFindInputSchema, payload);
        const items = await this.repository.listNotes(execution.scope, input);
        return readEnvelope(action, { count: items.length, items });
      }
      case 'review.daily':
      case 'review.weekly': {
        const input = parseInput(reviewReadInputSchema, payload);
        return readEnvelope(
          action,
          await this.buildReview(
            execution.scope,
            action === 'review.daily' ? 'daily' : 'weekly',
            input.date
          )
        );
      }
      case 'capture.add': {
        const input = parseInput(captureAddInputSchema, payload);
        const command = commandContext(action, input.idempotencyKey, execution);
        if (input.projectId) await this.assertProjectId(execution.scope, input.projectId);
        const result = await this.repository.createTask(
          execution.scope,
          {
            title: input.text,
            details: input.notes,
            status: 'inbox',
            projectId: input.projectId,
            priority: input.priority,
            dueAt: toIsoTimestamp(input.dueAt)
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'captured',
          message: `Captured “${result.value.title}” in your inbox.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'task.create': {
        const input = parseInput(taskCreateInputSchema, payload);
        const command = commandContext(action, input.idempotencyKey, execution);
        if (input.projectId) await this.assertProjectId(execution.scope, input.projectId);
        const result = await this.repository.createTask(
          execution.scope,
          {
            title: input.title,
            details: input.details,
            status: input.status,
            projectId: input.projectId,
            priority: input.priority,
            dueAt: toIsoTimestamp(input.dueAt),
            deferUntil: toIsoTimestamp(input.deferUntil)
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'created',
          message: `Created “${result.value.title}”.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'inbox.process': {
        const input = parseInput(inboxProcessInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityTask>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'processed',
            message: `Moved “${replay.value.title}” from inbox to ${replay.value.status}.`,
            entities: [{ type: 'task', id: replay.value.id }],
            data: { item: replay.value }
          });
        }
        const item = await this.requireResolvedTask(execution.scope, input.task);
        if (input.projectId) await this.assertProjectId(execution.scope, input.projectId);
        const result = await this.repository.transitionTask(
          execution.scope,
          item.id,
          {
            status: input.status,
            expectedVersion: input.expectedVersion,
            projectId: input.projectId,
            priority: input.priority,
            details: input.notes,
            dueAt: input.dueAt === null ? null : toIsoTimestamp(input.dueAt),
            deferUntil: input.deferUntil === null ? null : toIsoTimestamp(input.deferUntil)
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'processed',
          message: `Moved “${result.value.title}” from inbox to ${result.value.status}.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'task.complete': {
        const input = parseInput(taskCompleteInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityTask>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'completed',
            message: `“${replay.value.title}” was already complete.`,
            entities: [{ type: 'task', id: replay.value.id }],
            data: { item: replay.value }
          });
        }
        const item = await this.requireResolvedTask(execution.scope, input.task);
        const result = await this.repository.transitionTask(
          execution.scope,
          item.id,
          { status: 'done', expectedVersion: input.expectedVersion },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'completed',
          message: result.changed
            ? `Completed “${result.value.title}”.`
            : `“${result.value.title}” was already complete.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'task.defer': {
        const input = parseInput(taskDeferInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityTask>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'deferred',
            message: `Deferred “${replay.value.title}” until ${replay.value.deferUntil}.`,
            entities: [{ type: 'task', id: replay.value.id }],
            data: { item: replay.value }
          });
        }
        const item = await this.requireResolvedTask(execution.scope, input.task);
        const result = await this.repository.transitionTask(
          execution.scope,
          item.id,
          {
            status: 'scheduled',
            deferUntil: toIsoTimestamp(input.until),
            expectedVersion: input.expectedVersion
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'deferred',
          message: `Deferred “${result.value.title}” until ${result.value.deferUntil}.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'task.transition': {
        const input = parseInput(taskTransitionInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityTask>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'transitioned',
            message: `Moved “${replay.value.title}” to ${replay.value.status}.`,
            entities: [{ type: 'task', id: replay.value.id }],
            data: { item: replay.value }
          });
        }
        const item = await this.requireResolvedTask(execution.scope, input.task);
        if (input.projectId) await this.assertProjectId(execution.scope, input.projectId);
        const result = await this.repository.transitionTask(
          execution.scope,
          item.id,
          {
            status: input.status,
            expectedVersion: input.expectedVersion,
            projectId: input.projectId,
            priority: input.priority,
            details: input.details,
            dueAt: input.dueAt === null ? null : toIsoTimestamp(input.dueAt),
            deferUntil: input.deferUntil === null ? null : toIsoTimestamp(input.deferUntil)
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'transitioned',
          message: `Moved “${result.value.title}” to ${result.value.status}.`,
          entities: [{ type: 'task', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'project.create': {
        const input = parseInput(projectCreateInputSchema, payload);
        const result = await this.repository.createProject(
          execution.scope,
          {
            title: input.title,
            description: input.description,
            dueAt: toIsoTimestamp(input.dueAt)
          },
          commandContext(action, input.idempotencyKey, execution)
        );
        return mutationEnvelope(action, result, {
          outcome: 'created',
          message: `Created project “${result.value.title}”.`,
          entities: [{ type: 'project', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'project.advance': {
        const input = parseInput(projectAdvanceInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityProjectAdvanceResult>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'advanced',
            message: `Added the next action “${replay.value.task.title}” to “${replay.value.project.title}”.`,
            entities: [
              { type: 'project', id: replay.value.project.id },
              { type: 'task', id: replay.value.task.id }
            ],
            data: {
              project: replay.value.project,
              nextAction: replay.value.task
            }
          });
        }
        const project = await this.requireResolvedProject(execution.scope, input.project);
        const result = await this.repository.advanceProject(
          execution.scope,
          project.id,
          {
            nextAction: input.nextAction,
            details: input.details,
            priority: input.priority,
            dueAt: toIsoTimestamp(input.dueAt),
            expectedVersion: input.expectedVersion
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'advanced',
          message: `Added the next action “${result.value.task.title}” to “${result.value.project.title}”.`,
          entities: [
            { type: 'project', id: result.value.project.id },
            { type: 'task', id: result.value.task.id }
          ],
          data: {
            project: result.value.project,
            nextAction: result.value.task
          }
        });
      }
      case 'project.transition': {
        const input = parseInput(projectTransitionInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const command = commandContext(
          action,
          input.idempotencyKey,
          execution,
          semanticRequest
        );
        const replay = await this.repository.replayCommand<ProductivityProject>(
          execution.scope,
          command,
          semanticRequest
        );
        if (replay) {
          return mutationEnvelope(action, replay, {
            outcome: 'transitioned',
            message: `Moved project “${replay.value.title}” to ${replay.value.status}.`,
            entities: [{ type: 'project', id: replay.value.id }],
            data: { item: replay.value }
          });
        }
        const project = await this.requireResolvedProject(execution.scope, input.project);
        const result = await this.repository.transitionProject(
          execution.scope,
          project.id,
          {
            status: input.status,
            expectedVersion: input.expectedVersion
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'transitioned',
          message: `Moved project “${result.value.title}” to ${result.value.status}.`,
          entities: [{ type: 'project', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'knowledge.store': {
        const input = parseInput(knowledgeStoreInputSchema, payload);
        const command = commandContext(action, input.idempotencyKey, execution);
        if (input.projectId) await this.assertProjectId(execution.scope, input.projectId);
        const result = await this.repository.createNote(
          execution.scope,
          {
            title: input.title,
            content: input.content,
            projectId: input.projectId
          },
          command
        );
        return mutationEnvelope(action, result, {
          outcome: 'stored',
          message: result.value.title
            ? `Stored note “${result.value.title}”.`
            : 'Stored the note.',
          entities: [{ type: 'note', id: result.value.id }],
          data: { item: result.value }
        });
      }
      case 'review.record': {
        const input = parseInput(reviewRecordInputSchema, payload);
        const semanticRequest = semanticCommandInput(input);
        const result = await this.repository.recordReview(
          execution.scope,
          {
            kind: input.kind,
            reviewDate: input.reviewDate ?? toUtcDate(this.now()),
            content: {
              summary: input.summary,
              completed: input.completed,
              concerns: input.concerns,
              nextActions: input.nextActions
            }
          },
          commandContext(
            action,
            input.idempotencyKey,
            execution,
            semanticRequest
          )
        );
        return mutationEnvelope(action, result, {
          outcome: 'recorded',
          message: `Recorded your ${result.value.kind} review for ${result.value.reviewDate}.`,
          entities: [{ type: 'review', id: result.value.id }],
          data: { item: result.value }
        });
      }
      default:
        throw new ProductivityError({
          code: 'VALIDATION_FAILED',
          message: 'Unknown productivity action.',
          recoverable: true,
          recommendedAction: 'FIX_INPUT'
        });
    }
  }

  private async resolveReference(
    scope: ProductivityScope,
    entityType: ProductivityReferenceType,
    reference: string
  ): Promise<ReferenceResolution> {
    const candidates = entityType === 'task'
      ? await this.repository.findTasksByReference(scope, reference, REFERENCE_CANDIDATE_LIMIT)
      : await this.repository.findProjectsByReference(scope, reference, REFERENCE_CANDIDATE_LIMIT);
    const resolution = selectReferenceResolution(reference, candidates);
    if (!resolution) {
      throw new ProductivityError({
        code: 'NOT_FOUND',
        message: `${entityType === 'task' ? 'Task' : 'Project'} not found.`,
        recoverable: true,
        recommendedAction: 'ASK_USER'
      });
    }
    return resolution;
  }

  private async requireResolvedTask(
    scope: ProductivityScope,
    reference: string
  ): Promise<ProductivityTask> {
    const resolution = await this.resolveReference(scope, 'task', reference);
    if (resolution.status === 'resolved') {
      return resolution.entity as ProductivityTask;
    }
    throw this.ambiguousReferenceError('task', resolution.candidates);
  }

  private async requireResolvedProject(
    scope: ProductivityScope,
    reference: string
  ): Promise<ProductivityProject> {
    const resolution = await this.resolveReference(scope, 'project', reference);
    if (resolution.status === 'resolved') {
      return resolution.entity as ProductivityProject;
    }
    throw this.ambiguousReferenceError('project', resolution.candidates);
  }

  private ambiguousReferenceError(
    entityType: ProductivityReferenceType,
    candidates: Array<ProductivityTask | ProductivityProject>
  ): ProductivityError {
    return new ProductivityError({
      code: 'AMBIGUOUS_REFERENCE',
      message: `More than one ${entityType} matches that reference.`,
      recoverable: true,
      recommendedAction: 'ASK_USER',
      details: {
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          title: candidate.title,
          status: candidate.status,
          version: candidate.version
        }))
      }
    });
  }

  private publicReferenceResolution(
    entityType: ProductivityReferenceType,
    resolution: ReferenceResolution
  ) {
    if (resolution.status === 'resolved') {
      return {
        status: 'resolved',
        entityType,
        entity: resolution.entity
      };
    }
    return {
      status: 'ambiguous',
      entityType,
      candidates: resolution.candidates.map((candidate) => ({
        id: candidate.id,
        title: candidate.title,
        status: candidate.status,
        version: candidate.version
      }))
    };
  }

  private async assertProjectId(scope: ProductivityScope, projectId: string): Promise<void> {
    await this.requireResolvedProject(scope, projectId);
  }

  private async buildCurrentState(scope: ProductivityScope) {
    const now = this.now();
    const { tasks, projects, noteCount, reviews } =
      await this.repository.getCurrentStateSnapshot(scope);
    const tasksByProject = indexTasksByProject(tasks);
    const projectHealth = projects.map((project) =>
      calculateProjectHealth(project, tasksByProject.get(project.id) ?? [], now)
    );
    const focus = calculateFocus(tasks, projects, now);
    const reviewStatus = calculateReviewStatus(reviews, now);
    const openTasks = tasks.filter(isOpenTask);
    const overdue = openTasks.filter(
      (item) => item.dueAt !== null && new Date(item.dueAt).getTime() < now.getTime()
    );
    const warnings = projectHealth
      .filter((item) => item.health === 'blocked' || item.health === 'stalled' || item.health === 'at_risk')
      .map((item) => ({
        projectId: item.project.id,
        title: item.project.title,
        health: item.health,
        reasonCodes: item.reasonCodes
      }));

    return {
      generatedAt: now.toISOString(),
      summary: {
        tasks: {
          open: openTasks.length,
          inbox: tasks.filter((item) => item.status === 'inbox').length,
          next: tasks.filter((item) => item.status === 'next').length,
          scheduled: tasks.filter((item) => item.status === 'scheduled').length,
          waiting: tasks.filter((item) => item.status === 'waiting').length,
          overdue: overdue.length,
          completed: tasks.filter((item) => item.status === 'done').length
        },
        projects: {
          active: projects.filter((item) => item.status === 'active').length,
          blocked: projects.filter((item) => item.status === 'blocked').length,
          onHold: projects.filter((item) => item.status === 'on_hold').length,
          missingNextAction: projectHealth.filter((item) => item.missingNextAction).length
        },
        knowledge: {
          notes: noteCount
        },
        reviews: {
          dailyDue: reviewStatus.daily.due,
          weeklyDue: reviewStatus.weekly.due
        }
      },
      focus,
      projectHealth,
      warnings,
      reviewStatus
    };
  }

  private async buildReview(
    scope: ProductivityScope,
    kind: ProductivityReviewKind,
    requestedDate?: string
  ) {
    const state = await this.buildCurrentState(scope);
    const reviewDate = requestedDate ?? toUtcDate(this.now());
    const checklist = kind === 'daily'
      ? [
          'Process remaining inbox items.',
          'Review overdue and due-today commitments.',
          'Confirm each active project has a next action.',
          'Choose a realistic Focus 3.',
          'Record unfinished work intentionally.'
        ]
      : [
          'Empty the capture inbox.',
          'Review every active and blocked project.',
          'Add a next action to stalled projects.',
          'Review waiting and overdue commitments.',
          'Record decisions and priorities for the next week.'
        ];

    return {
      kind,
      reviewDate,
      due: kind === 'daily'
        ? state.reviewStatus.daily.due
        : state.reviewStatus.weekly.due,
      checklist,
      evidence: {
        summary: state.summary,
        warnings: state.warnings,
        focus: state.focus.recommended
      }
    };
  }
}
