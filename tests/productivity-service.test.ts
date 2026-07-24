import { ProductivityService } from '../src/services/productivity/productivityService.js';
import {
  PRODUCTIVITY_PROJECT_TRANSITIONS,
  PRODUCTIVITY_TASK_TRANSITIONS,
  ProductivityError,
  type ProductivityAdvanceProjectInput,
  type ProductivityCommandContext,
  type ProductivityCreateNoteInput,
  type ProductivityCreateProjectInput,
  type ProductivityCreateTaskInput,
  type ProductivityMutationResult,
  type ProductivityNote,
  type ProductivityNoteListFilter,
  type ProductivityProject,
  type ProductivityProjectAdvanceResult,
  type ProductivityProjectListFilter,
  type ProductivityRecordReviewInput,
  type ProductivityRepository,
  type ProductivityReview,
  type ProductivityReviewListFilter,
  type ProductivityScope,
  type ProductivityTask,
  type ProductivityTaskListFilter,
  type ProductivityTransitionProjectInput,
  type ProductivityTransitionTaskInput,
} from '../src/services/productivity/productivityTypes.js';

const NOW = new Date('2026-07-24T12:00:00.000Z');
const BASE_SCOPE: ProductivityScope = {
  principalId: 'principal:test',
  workspaceId: 'workspace:test',
  actorKey: 'actor:test',
  traceId: 'trace:test',
};

const PROJECT_ATLAS_ID = '00000000-0000-4000-8000-000000000001';
const PROJECT_STALLED_ID = '00000000-0000-4000-8000-000000000002';
const PROJECT_BLOCKED_ID = '00000000-0000-4000-8000-000000000003';
const TASK_INBOX_ID = '00000000-0000-4000-8000-000000000101';
const TASK_DONE_ID = '00000000-0000-4000-8000-000000000102';
const TASK_CANCELLED_ID = '00000000-0000-4000-8000-000000000103';

function makeTask(
  input: Pick<ProductivityTask, 'id' | 'title' | 'status'> & Partial<ProductivityTask>,
): ProductivityTask {
  return {
    id: input.id,
    projectId: null,
    title: input.title,
    details: null,
    status: input.status,
    priority: 0,
    dueAt: null,
    deferUntil: null,
    completedAt: input.status === 'done' ? NOW.toISOString() : null,
    version: 1,
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:00:00.000Z',
    ...input,
  };
}

function makeProject(
  input: Pick<ProductivityProject, 'id' | 'title' | 'status'> & Partial<ProductivityProject>,
): ProductivityProject {
  return {
    id: input.id,
    title: input.title,
    description: null,
    status: input.status,
    dueAt: null,
    completedAt: input.status === 'completed' ? NOW.toISOString() : null,
    version: 1,
    createdAt: '2026-07-20T09:00:00.000Z',
    updatedAt: '2026-07-20T09:00:00.000Z',
    ...input,
  };
}

function generatedUuid(sequence: number): string {
  return `10000000-0000-4000-8000-${sequence.toString().padStart(12, '0')}`;
}

type Receipt = {
  fingerprint: string;
  value: unknown;
};

class InMemoryProductivityRepository implements ProductivityRepository {
  tasks: ProductivityTask[];
  projects: ProductivityProject[];
  notes: ProductivityNote[];
  reviews: ProductivityReview[];
  readonly commands: ProductivityCommandContext[] = [];
  transitionTaskCalls = 0;
  createTaskExecutions = 0;
  projectReferenceReads = 0;

  private readonly receipts = new Map<string, Receipt>();
  private sequence = 1_000;

  constructor(input: {
    tasks?: ProductivityTask[];
    projects?: ProductivityProject[];
    notes?: ProductivityNote[];
    reviews?: ProductivityReview[];
  } = {}) {
    this.tasks = [...(input.tasks ?? [])];
    this.projects = [...(input.projects ?? [])];
    this.notes = [...(input.notes ?? [])];
    this.reviews = [...(input.reviews ?? [])];
  }

  async getCurrentStateSnapshot() {
    return {
      tasks: [...this.tasks],
      projects: [...this.projects],
      noteCount: this.notes.length,
      reviews: [...this.reviews],
    };
  }

  async replayCommand<T>(
    scope: ProductivityScope,
    command: ProductivityCommandContext,
    semanticRequest: unknown,
  ): Promise<ProductivityMutationResult<T> | null> {
    const receipt = this.receipts.get(this.receiptKey(scope, command));
    if (!receipt) {
      return null;
    }
    const fingerprint = JSON.stringify(semanticRequest);
    if (receipt.fingerprint !== fingerprint) {
      throw new ProductivityError({
        code: 'IDEMPOTENCY_CONFLICT',
        message: 'The idempotency key was already used for another command.',
        recoverable: true,
        recommendedAction: 'CHANGE_IDEMPOTENCY_KEY',
      });
    }
    return {
      value: receipt.value as T,
      replayed: true,
      changed: false,
    };
  }

  async listTasks(
    _scope: ProductivityScope,
    filter: ProductivityTaskListFilter = {},
  ): Promise<ProductivityTask[]> {
    return this.tasks
      .filter((item) => filter.status === undefined || item.status === filter.status)
      .filter((item) => filter.projectId === undefined || item.projectId === filter.projectId)
      .slice(0, filter.limit);
  }

  async listProjects(
    _scope: ProductivityScope,
    filter: ProductivityProjectListFilter = {},
  ): Promise<ProductivityProject[]> {
    return this.projects
      .filter((item) => filter.status === undefined || item.status === filter.status)
      .slice(0, filter.limit);
  }

  async listNotes(
    _scope: ProductivityScope,
    filter: ProductivityNoteListFilter = {},
  ): Promise<ProductivityNote[]> {
    const query = filter.query?.toLocaleLowerCase('en-US');
    return this.notes
      .filter((item) => filter.projectId === undefined || item.projectId === filter.projectId)
      .filter((item) => (
        query === undefined
        || item.title?.toLocaleLowerCase('en-US').includes(query)
        || item.content.toLocaleLowerCase('en-US').includes(query)
      ))
      .slice(0, filter.limit);
  }

  async listReviews(
    _scope: ProductivityScope,
    filter: ProductivityReviewListFilter = {},
  ): Promise<ProductivityReview[]> {
    return this.reviews
      .filter((item) => filter.kind === undefined || item.kind === filter.kind)
      .slice(0, filter.limit);
  }

  async findTasksByReference(
    _scope: ProductivityScope,
    reference: string,
    limit = 8,
  ): Promise<ProductivityTask[]> {
    return this.findByReference(this.tasks, reference).slice(0, limit);
  }

  async findProjectsByReference(
    _scope: ProductivityScope,
    reference: string,
    limit = 8,
  ): Promise<ProductivityProject[]> {
    this.projectReferenceReads += 1;
    return this.findByReference(this.projects, reference).slice(0, limit);
  }

  async createTask(
    scope: ProductivityScope,
    input: ProductivityCreateTaskInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityTask>> {
    return this.withReceipt(scope, command, input, () => {
      this.createTaskExecutions += 1;
      const item = makeTask({
        id: generatedUuid(this.sequence++),
        title: input.title,
        details: input.details ?? null,
        status: input.status,
        projectId: input.projectId ?? null,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        deferUntil: input.deferUntil ?? null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      this.tasks.push(item);
      return { value: item, replayed: false, changed: true };
    });
  }

  async transitionTask(
    scope: ProductivityScope,
    taskId: string,
    input: ProductivityTransitionTaskInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityTask>> {
    this.transitionTaskCalls += 1;
    return this.withReceipt(scope, command, { taskId, ...input }, () => {
      const index = this.tasks.findIndex((item) => item.id === taskId);
      if (index < 0) {
        throw new ProductivityError({
          code: 'NOT_FOUND',
          message: 'Task not found.',
          recoverable: true,
          recommendedAction: 'ASK_USER',
        });
      }
      const current = this.tasks[index];
      if (
        input.expectedVersion !== undefined
        && input.expectedVersion !== current.version
      ) {
        throw new ProductivityError({
          code: 'STALE_PLAN',
          message: 'The item changed after this command was prepared.',
          recoverable: true,
          recommendedAction: 'REPLAN',
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: current.version,
          },
        });
      }
      if (command.action === 'inbox.process' && current.status !== 'inbox') {
        throw new ProductivityError({
          code: 'INVALID_TRANSITION',
          message: 'Only inbox tasks can be processed through inbox.process.',
          recoverable: true,
          recommendedAction: 'REPLAN',
        });
      }
      if (
        current.status !== input.status
        && !PRODUCTIVITY_TASK_TRANSITIONS[current.status].includes(input.status)
      ) {
        throw new ProductivityError({
          code: 'INVALID_TRANSITION',
          message: `Task cannot transition from ${current.status} to ${input.status}.`,
          recoverable: true,
          recommendedAction: 'REPLAN',
        });
      }
      const changed = (
        current.status !== input.status
        || (input.projectId !== undefined && current.projectId !== input.projectId)
        || (input.priority !== undefined && current.priority !== input.priority)
        || (input.details !== undefined && current.details !== input.details)
        || (input.dueAt !== undefined && current.dueAt !== input.dueAt)
        || (input.deferUntil !== undefined && current.deferUntil !== input.deferUntil)
      );
      if (!changed) {
        return { value: current, replayed: false, changed: false };
      }
      const updated: ProductivityTask = {
        ...current,
        status: input.status,
        projectId: input.projectId ?? current.projectId,
        priority: input.priority ?? current.priority,
        details: input.details ?? current.details,
        dueAt: input.dueAt === undefined ? current.dueAt : input.dueAt,
        deferUntil: input.deferUntil === undefined ? current.deferUntil : input.deferUntil,
        completedAt: input.status === 'done' ? NOW.toISOString() : null,
        version: current.version + 1,
        updatedAt: NOW.toISOString(),
      };
      this.tasks[index] = updated;
      return { value: updated, replayed: false, changed: true };
    });
  }

  async createProject(
    scope: ProductivityScope,
    input: ProductivityCreateProjectInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityProject>> {
    return this.withReceipt(scope, command, input, () => {
      const item = makeProject({
        id: generatedUuid(this.sequence++),
        title: input.title,
        description: input.description ?? null,
        status: 'active',
        dueAt: input.dueAt ?? null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      this.projects.push(item);
      return { value: item, replayed: false, changed: true };
    });
  }

  async transitionProject(
    scope: ProductivityScope,
    projectId: string,
    input: ProductivityTransitionProjectInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityProject>> {
    return this.withReceipt(scope, command, { projectId, ...input }, () => {
      const index = this.projects.findIndex((item) => item.id === projectId);
      if (index < 0) {
        throw new ProductivityError({
          code: 'NOT_FOUND',
          message: 'Project not found.',
          recoverable: true,
          recommendedAction: 'ASK_USER',
        });
      }
      const current = this.projects[index];
      if (
        input.expectedVersion !== undefined
        && input.expectedVersion !== current.version
      ) {
        throw new ProductivityError({
          code: 'STALE_PLAN',
          message: 'The item changed after this command was prepared.',
          recoverable: true,
          recommendedAction: 'REPLAN',
          details: {
            expectedVersion: input.expectedVersion,
            currentVersion: current.version,
          },
        });
      }
      if (
        current.status !== input.status
        && !PRODUCTIVITY_PROJECT_TRANSITIONS[current.status].includes(input.status)
      ) {
        throw new ProductivityError({
          code: 'INVALID_TRANSITION',
          message: `Project cannot transition from ${current.status} to ${input.status}.`,
          recoverable: true,
          recommendedAction: 'REPLAN',
        });
      }
      if (current.status === input.status) {
        return { value: current, replayed: false, changed: false };
      }
      const updated: ProductivityProject = {
        ...current,
        status: input.status,
        completedAt: input.status === 'completed' ? NOW.toISOString() : current.completedAt,
        version: current.version + 1,
        updatedAt: NOW.toISOString(),
      };
      this.projects[index] = updated;
      return { value: updated, replayed: false, changed: true };
    });
  }

  async advanceProject(
    scope: ProductivityScope,
    projectId: string,
    input: ProductivityAdvanceProjectInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityProjectAdvanceResult>> {
    return this.withReceipt(scope, command, { projectId, ...input }, () => {
      const index = this.projects.findIndex((item) => item.id === projectId);
      if (index < 0) {
        throw new ProductivityError({
          code: 'NOT_FOUND',
          message: 'Project not found.',
          recoverable: true,
          recommendedAction: 'ASK_USER',
        });
      }
      const current = this.projects[index];
      if (
        input.expectedVersion !== undefined
        && input.expectedVersion !== current.version
      ) {
        throw new ProductivityError({
          code: 'STALE_PLAN',
          message: 'The item changed after this command was prepared.',
          recoverable: true,
          recommendedAction: 'REPLAN',
        });
      }
      if (current.status === 'completed' || current.status === 'archived') {
        throw new ProductivityError({
          code: 'INVALID_TRANSITION',
          message: 'Completed or archived projects cannot be advanced.',
          recoverable: true,
          recommendedAction: 'REPLAN',
        });
      }
      const project: ProductivityProject = {
        ...current,
        version: current.version + 1,
        updatedAt: NOW.toISOString(),
      };
      const task = makeTask({
        id: generatedUuid(this.sequence++),
        title: input.nextAction,
        details: input.details ?? null,
        status: 'next',
        projectId,
        priority: input.priority,
        dueAt: input.dueAt ?? null,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      });
      this.projects[index] = project;
      this.tasks.push(task);
      return {
        value: { project, task },
        replayed: false,
        changed: true,
      };
    });
  }

  async createNote(
    scope: ProductivityScope,
    input: ProductivityCreateNoteInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityNote>> {
    return this.withReceipt(scope, command, input, () => {
      const item: ProductivityNote = {
        id: generatedUuid(this.sequence++),
        projectId: input.projectId ?? null,
        title: input.title ?? null,
        content: input.content,
        version: 1,
        createdAt: NOW.toISOString(),
        updatedAt: NOW.toISOString(),
      };
      this.notes.push(item);
      return { value: item, replayed: false, changed: true };
    });
  }

  async recordReview(
    scope: ProductivityScope,
    input: ProductivityRecordReviewInput,
    command: ProductivityCommandContext,
  ): Promise<ProductivityMutationResult<ProductivityReview>> {
    return this.withReceipt(scope, command, input, () => {
      const item: ProductivityReview = {
        id: generatedUuid(this.sequence++),
        kind: input.kind,
        reviewDate: input.reviewDate,
        content: input.content,
        createdAt: NOW.toISOString(),
      };
      this.reviews.push(item);
      return { value: item, replayed: false, changed: true };
    });
  }

  private findByReference<T extends ProductivityTask | ProductivityProject>(
    items: T[],
    reference: string,
  ): T[] {
    const normalized = reference.trim().toLocaleLowerCase('en-US');
    return items
      .filter((item) => (
        item.id.toLocaleLowerCase('en-US') === normalized
        || item.title.toLocaleLowerCase('en-US').includes(normalized)
      ))
      .sort((left, right) => {
        const rank = (item: T): number => {
          const title = item.title.toLocaleLowerCase('en-US');
          if (item.id.toLocaleLowerCase('en-US') === normalized) return 0;
          if (title === normalized) return 1;
          if (title.startsWith(normalized)) return 2;
          return 3;
        };
        return rank(left) - rank(right) || left.title.localeCompare(right.title);
      });
  }

  private async withReceipt<T>(
    scope: ProductivityScope,
    command: ProductivityCommandContext,
    fingerprintInput: unknown,
    mutate: () => ProductivityMutationResult<T>,
  ): Promise<ProductivityMutationResult<T>> {
    this.commands.push(command);
    const key = this.receiptKey(scope, command);
    const fingerprint = JSON.stringify(command.semanticRequest ?? fingerprintInput);
    const receipt = this.receipts.get(key);
    if (receipt) {
      if (receipt.fingerprint !== fingerprint) {
        throw new ProductivityError({
          code: 'IDEMPOTENCY_CONFLICT',
          message: 'The idempotency key was already used for another command.',
          recoverable: true,
          recommendedAction: 'CHANGE_IDEMPOTENCY_KEY',
        });
      }
      return {
        value: receipt.value as T,
        replayed: true,
        changed: false,
      };
    }

    const result = mutate();
    this.receipts.set(key, {
      fingerprint,
      value: result.value,
    });
    return result;
  }

  private receiptKey(
    scope: ProductivityScope,
    command: ProductivityCommandContext,
  ): string {
    return [
      scope.principalId,
      scope.workspaceId,
      command.action,
      command.idempotencyKey,
    ].join(':');
  }
}

function execution(requestId: string, idempotencyKey?: string) {
  return {
    scope: {
      ...BASE_SCOPE,
      requestId,
    },
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

function dataOf<T>(response: { data: unknown }): T {
  return response.data as T;
}

async function expectProductivityError(
  promise: Promise<unknown>,
  code: ProductivityError['code'],
): Promise<ProductivityError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProductivityError);
    const productivityError = error as ProductivityError;
    expect(productivityError.code).toBe(code);
    return productivityError;
  }
  throw new Error(`Expected ProductivityError ${code}.`);
}

function containsExactTaskKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsExactTaskKey);
  }
  if (!value || typeof value !== 'object') {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'task')) {
    return true;
  }
  return Object.values(value as Record<string, unknown>).some(containsExactTaskKey);
}

describe('ProductivityService domain and security contracts', () => {
  test.each([
    'ownerId',
    'owner_id',
    'owner-id',
    'principalId',
    'principal_id',
    'principal.id',
    'workspaceId',
    'workspace_id',
    'workspace-id',
  ])('rejects caller-supplied tenancy alias %s before repository access', async (alias) => {
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => NOW);
    const payload = {
      title: 'Untrusted task',
      [alias]: 'another-tenant',
    };

    const error = await expectProductivityError(
      service.execute('task.create', payload, execution(`forbidden-${alias}`)),
      'PERMISSION_DENIED',
    );

    expect(error.recommendedAction).toBe('FIX_INPUT');
    expect(error.details).toEqual({ forbiddenField: alias });
    expect(repository.commands).toHaveLength(0);
    expect(repository.tasks).toHaveLength(0);
  });

  test('rejects forbidden tenancy aliases recursively', async () => {
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => NOW);

    await expectProductivityError(
      service.execute(
        'task.create',
        {
          title: 'Untrusted task',
          metadata: {
            workspaceId: 'another-workspace',
          },
        },
        execution('forbidden-nested'),
      ),
      'PERMISSION_DENIED',
    );

    expect(repository.commands).toHaveLength(0);
  });

  test('enforces canonical task and project transitions', async () => {
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({
          id: TASK_INBOX_ID,
          title: 'Clarify launch plan',
          status: 'inbox',
        }),
      ],
      projects: [
        makeProject({
          id: PROJECT_ATLAS_ID,
          title: 'Project Atlas',
          status: 'active',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    const processed = await service.execute(
      'inbox.process',
      {
        task: TASK_INBOX_ID,
        status: 'next',
        expectedVersion: 1,
      },
      execution('task-next'),
    );
    expect(dataOf<{ item: ProductivityTask }>(processed).item).toMatchObject({
      status: 'next',
      version: 2,
    });

    const deferred = await service.execute(
      'task.defer',
      {
        task: TASK_INBOX_ID,
        until: '2026-07-26T09:00:00.000Z',
        expectedVersion: 2,
      },
      execution('task-scheduled'),
    );
    expect(dataOf<{ item: ProductivityTask }>(deferred).item).toMatchObject({
      status: 'scheduled',
      version: 3,
    });

    for (const [index, status] of (['waiting', 'next', 'done'] as const).entries()) {
      const response = await service.execute(
        'task.transition',
        {
          task: TASK_INBOX_ID,
          status,
          expectedVersion: index + 3,
        },
        execution(`task-${status}`),
      );
      expect(dataOf<{ item: ProductivityTask }>(response).item).toMatchObject({
        status,
        version: index + 4,
      });
    }

    const projectStatuses = [
      'blocked',
      'on_hold',
      'active',
      'completed',
      'archived',
    ] as const;
    for (const [index, status] of projectStatuses.entries()) {
      const response = await service.execute(
        'project.transition',
        {
          project: PROJECT_ATLAS_ID,
          status,
          expectedVersion: index + 1,
        },
        execution(`project-${status}`),
      );
      expect(dataOf<{ item: ProductivityProject }>(response).item).toMatchObject({
        status,
        version: index + 2,
      });
    }
  });

  test('rejects transitions out of terminal task and project states', async () => {
    const completedProjectId = '00000000-0000-4000-8000-000000000011';
    const archivedProjectId = '00000000-0000-4000-8000-000000000012';
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({ id: TASK_DONE_ID, title: 'Already done', status: 'done' }),
        makeTask({ id: TASK_CANCELLED_ID, title: 'Cancelled work', status: 'cancelled' }),
      ],
      projects: [
        makeProject({ id: completedProjectId, title: 'Completed project', status: 'completed' }),
        makeProject({ id: archivedProjectId, title: 'Archived project', status: 'archived' }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    await expectProductivityError(
      service.execute(
        'task.transition',
        { task: TASK_DONE_ID, status: 'next' },
        execution('done-to-next'),
      ),
      'INVALID_TRANSITION',
    );
    await expectProductivityError(
      service.execute(
        'task.complete',
        { task: TASK_CANCELLED_ID },
        execution('cancelled-to-done'),
      ),
      'INVALID_TRANSITION',
    );
    await expectProductivityError(
      service.execute(
        'project.transition',
        { project: completedProjectId, status: 'active' },
        execution('completed-to-active'),
      ),
      'INVALID_TRANSITION',
    );
    await expectProductivityError(
      service.execute(
        'project.transition',
        { project: archivedProjectId, status: 'active' },
        execution('archived-to-active'),
      ),
      'INVALID_TRANSITION',
    );

    expect(repository.transitionTaskCalls).toBe(2);
  });

  test('rejects stale expectedVersion at the mutation boundary', async () => {
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({
          id: TASK_INBOX_ID,
          title: 'Versioned task',
          status: 'next',
          version: 4,
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    const error = await expectProductivityError(
      service.execute(
        'task.complete',
        {
          task: TASK_INBOX_ID,
          expectedVersion: 3,
        },
        execution('stale-task'),
      ),
      'STALE_PLAN',
    );

    expect(error.recommendedAction).toBe('REPLAN');
    expect(error.details).toEqual({
      expectedVersion: 3,
      currentVersion: 4,
    });
    expect(repository.transitionTaskCalls).toBe(1);
  });

  test('replays a completed task command before revalidating its new terminal state', async () => {
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({
          id: TASK_INBOX_ID,
          title: 'Complete exactly once',
          status: 'next',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);
    const payload = {
      task: TASK_INBOX_ID,
      expectedVersion: 1,
      idempotencyKey: 'complete-exactly-once',
    };

    const first = await service.execute(
      'task.complete',
      payload,
      execution('complete-first'),
    );
    const replay = await service.execute(
      'task.complete',
      payload,
      execution('complete-replay'),
    );

    expect(first).toMatchObject({ replayed: false, changed: true });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(dataOf<{ item: ProductivityTask }>(replay).item).toMatchObject({
      status: 'done',
      version: 2,
    });
  });

  test('replays a title-resolved command before later ambiguity and rejects changed semantics', async () => {
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({
          id: TASK_INBOX_ID,
          title: 'Approve launch budget',
          status: 'next',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);
    const payload = {
      task: 'Approve launch budget',
      expectedVersion: 1,
      idempotencyKey: 'complete-by-title',
    };

    const first = await service.execute(
      'task.complete',
      payload,
      execution('complete-by-title-first'),
    );
    repository.tasks.push(makeTask({
      id: '00000000-0000-4000-8000-000000000109',
      title: 'Approve launch budget',
      status: 'next',
    }));
    const replay = await service.execute(
      'task.complete',
      payload,
      execution('complete-by-title-replay'),
    );

    expect(first).toMatchObject({ replayed: false, changed: true });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(repository.transitionTaskCalls).toBe(1);

    await expectProductivityError(
      service.execute(
        'task.complete',
        {
          ...payload,
          expectedVersion: 2,
        },
        execution('complete-by-title-conflict'),
      ),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(repository.transitionTaskCalls).toBe(1);
  });

  test('resolves an exact title and exposes ambiguity without guessing', async () => {
    const exactId = '00000000-0000-4000-8000-000000000121';
    const acmeId = '00000000-0000-4000-8000-000000000122';
    const northstarId = '00000000-0000-4000-8000-000000000123';
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({ id: exactId, title: 'Approve launch budget', status: 'next' }),
        makeTask({ id: acmeId, title: 'Client agenda for Acme', status: 'next' }),
        makeTask({ id: northstarId, title: 'Client agenda for Northstar', status: 'next' }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    const exact = await service.execute(
      'reference.resolve',
      {
        entityType: 'task',
        reference: 'Approve launch budget',
      },
      execution('reference-exact'),
    );
    expect(dataOf<{ status: string; entity: ProductivityTask }>(exact)).toMatchObject({
      status: 'resolved',
      entity: { id: exactId },
    });

    const ambiguous = await service.execute(
      'reference.resolve',
      {
        entityType: 'task',
        reference: 'Client agenda',
      },
      execution('reference-ambiguous'),
    );
    expect(dataOf<{ status: string; candidates: Array<{ id: string }> }>(ambiguous)).toEqual({
      status: 'ambiguous',
      entityType: 'task',
      candidates: [
        expect.objectContaining({ id: acmeId }),
        expect.objectContaining({ id: northstarId }),
      ],
    });

    const error = await expectProductivityError(
      service.execute(
        'task.complete',
        { task: 'Client agenda' },
        execution('ambiguous-command'),
      ),
      'AMBIGUOUS_REFERENCE',
    );
    expect(error.recommendedAction).toBe('ASK_USER');
    expect(repository.transitionTaskCalls).toBe(0);
  });

  test('filters snapshot projects before resolving a project-health reference', async () => {
    const repository = new InMemoryProductivityRepository({
      projects: [
        makeProject({
          id: PROJECT_ATLAS_ID,
          title: 'Project Atlas',
          status: 'active',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    const health = await service.execute(
      'project.health',
      { project: 'Atlas' },
      execution('health-reference'),
    );
    expect(dataOf<{
      count: number;
      items: Array<{ project: ProductivityProject }>;
    }>(health)).toMatchObject({
      count: 1,
      items: [
        {
          project: {
            id: PROJECT_ATLAS_ID,
          },
        },
      ],
    });

    await expectProductivityError(
      service.execute(
        'project.health',
        { project: 'Does not exist' },
        execution('health-reference-missing'),
      ),
      'NOT_FOUND',
    );
  });

  test.each([
    ['Remember this.', 'capture', ['capture.add']],
    ['What should I do?', 'focus', ['focus.today']],
    ["I'm overwhelmed.", 'focus', ['focus.today']],
    ['I finished that.', 'complete_task', ['task.complete']],
    ['Plan my day.', 'plan_day', ['state.current', 'focus.today']],
    ["What's going on?", 'context', ['context.summary']],
  ])(
    'maps conversational phrase %s to the stable intent vocabulary',
    async (utterance, verb, recommendedActions) => {
      const service = new ProductivityService(
        new InMemoryProductivityRepository(),
        () => NOW,
      );

      const response = await service.execute(
        'intent.resolve',
        { utterance },
        execution(`intent-${verb}`),
      );

      expect(response.persisted).toBe(false);
      expect(response.data).toMatchObject({
        status: 'resolved',
        verb,
        recommendedActions,
      });
    },
  );

  test.each([
    'I did not finish that.',
    "I didn't finish that.",
    "I haven't completed that.",
    "I'm not done with that.",
    'I did some planning.',
    'Do not defer that.',
    "Don't capture this.",
    'Do not create a task.',
    'Never process the inbox.',
    "Don't advance the project.",
    'Do not store this knowledge.',
  ])('does not interpret a negative or ambiguous statement as a mutation: %s', async (utterance) => {
    const service = new ProductivityService(
      new InMemoryProductivityRepository(),
      () => NOW,
    );

    const response = await service.execute(
      'intent.resolve',
      { utterance },
      execution('intent-negative-completion'),
    );

    expect(response.data).toEqual({
      status: 'unknown',
      verb: null,
      recommendedActions: [],
      confidence: 0,
    });
  });

  test('keeps focus, current-state, and project-health projections deterministic', async () => {
    const projects = [
      makeProject({
        id: PROJECT_ATLAS_ID,
        title: 'Project Atlas',
        status: 'active',
        dueAt: '2026-07-26T09:00:00.000Z',
      }),
      makeProject({
        id: PROJECT_STALLED_ID,
        title: 'Project Drift',
        status: 'active',
      }),
      makeProject({
        id: PROJECT_BLOCKED_ID,
        title: 'Project Blocked',
        status: 'blocked',
      }),
    ];
    const tasks = [
      makeTask({
        id: '00000000-0000-4000-8000-000000000201',
        title: 'Approve launch budget',
        status: 'next',
        projectId: PROJECT_ATLAS_ID,
        priority: 4,
        dueAt: '2026-07-23T18:00:00.000Z',
        createdAt: '2026-07-20T09:00:00.000Z',
      }),
      makeTask({
        id: '00000000-0000-4000-8000-000000000202',
        title: 'Prepare client agenda',
        status: 'scheduled',
        priority: 3,
        dueAt: '2026-07-24T18:00:00.000Z',
        createdAt: '2026-07-20T10:00:00.000Z',
      }),
      makeTask({
        id: '00000000-0000-4000-8000-000000000203',
        title: 'Draft launch notes',
        status: 'next',
        projectId: PROJECT_ATLAS_ID,
        priority: 1,
        dueAt: '2026-07-26T18:00:00.000Z',
        createdAt: '2026-07-20T11:00:00.000Z',
      }),
      makeTask({
        id: '00000000-0000-4000-8000-000000000204',
        title: 'Future deferred work',
        status: 'next',
        priority: 4,
        dueAt: '2026-07-24T20:00:00.000Z',
        deferUntil: '2026-07-25T09:00:00.000Z',
      }),
      makeTask({
        id: '00000000-0000-4000-8000-000000000205',
        title: 'Waiting on vendor',
        status: 'waiting',
        projectId: PROJECT_BLOCKED_ID,
        priority: 4,
        dueAt: '2026-07-22T18:00:00.000Z',
      }),
      makeTask({
        id: '00000000-0000-4000-8000-000000000206',
        title: 'Finished setup',
        status: 'done',
      }),
    ];
    const repository = new InMemoryProductivityRepository({
      tasks,
      projects,
      notes: [{
        id: '00000000-0000-4000-8000-000000000301',
        projectId: PROJECT_ATLAS_ID,
        title: 'Launch decision',
        content: 'Ship behind a feature flag.',
        version: 1,
        createdAt: '2026-07-20T09:00:00.000Z',
        updatedAt: '2026-07-20T09:00:00.000Z',
      }],
    });
    const service = new ProductivityService(repository, () => NOW);

    const focus = await service.execute('focus.today', {}, execution('focus-one'));
    const focusAgain = await service.execute('focus.today', {}, execution('focus-two'));
    expect(focusAgain.data).toEqual(focus.data);
    const focusData = dataOf<{
      generatedAt: string;
      candidateCount: number;
      recommended: Array<{
        item: ProductivityTask;
        score: number;
        reasonCodes: string[];
      }>;
    }>(focus);
    expect(focusData.generatedAt).toBe(NOW.toISOString());
    expect(focusData.candidateCount).toBe(3);
    expect(focusData.recommended.map((entry) => entry.item.title)).toEqual([
      'Approve launch budget',
      'Prepare client agenda',
      'Draft launch notes',
    ]);
    expect(focusData.recommended[0]).toMatchObject({
      score: 215,
      reasonCodes: [
        'high_priority',
        'overdue',
        'active_project',
        'project_due_soon',
      ],
    });

    const health = await service.execute('project.health', {}, execution('health-one'));
    const healthAgain = await service.execute('project.health', {}, execution('health-two'));
    expect(healthAgain.data).toEqual(health.data);
    const healthData = dataOf<{
      count: number;
      items: Array<{
        project: ProductivityProject;
        health: string;
        missingNextAction: boolean;
        reasonCodes: string[];
      }>;
    }>(health);
    expect(healthData.count).toBe(3);
    expect(healthData.items.map((item) => ({
      title: item.project.title,
      health: item.health,
      missingNextAction: item.missingNextAction,
      reasonCodes: item.reasonCodes,
    }))).toEqual([
      {
        title: 'Project Atlas',
        health: 'at_risk',
        missingNextAction: false,
        reasonCodes: ['overdue_tasks'],
      },
      {
        title: 'Project Drift',
        health: 'stalled',
        missingNextAction: true,
        reasonCodes: ['missing_next_action'],
      },
      {
        title: 'Project Blocked',
        health: 'blocked',
        missingNextAction: true,
        reasonCodes: ['project_marked_blocked', 'waiting_tasks'],
      },
    ]);

    const state = await service.execute('state.current', {}, execution('state-one'));
    const stateAgain = await service.execute('state.current', {}, execution('state-two'));
    expect(stateAgain.data).toEqual(state.data);
    expect(state.data).toMatchObject({
      generatedAt: NOW.toISOString(),
      summary: {
        tasks: {
          open: 5,
          inbox: 0,
          next: 3,
          scheduled: 1,
          waiting: 1,
          overdue: 2,
          completed: 1,
        },
        projects: {
          active: 2,
          blocked: 1,
          onHold: 0,
          missingNextAction: 2,
        },
        knowledge: { notes: 1 },
        reviews: {
          dailyDue: true,
          weeklyDue: true,
        },
      },
      warnings: [
        expect.objectContaining({ title: 'Project Atlas', health: 'at_risk' }),
        expect.objectContaining({ title: 'Project Drift', health: 'stalled' }),
        expect.objectContaining({ title: 'Project Blocked', health: 'blocked' }),
      ],
    });
  });

  test('classifies earlier-today deadlines as overdue and excludes terminal-project work', async () => {
    const completedProjectId = '00000000-0000-4000-8000-000000000051';
    const repository = new InMemoryProductivityRepository({
      projects: [
        makeProject({
          id: completedProjectId,
          title: 'Completed launch',
          status: 'completed',
        }),
      ],
      tasks: [
        makeTask({
          id: '00000000-0000-4000-8000-000000000251',
          title: 'Late this morning',
          status: 'next',
          dueAt: '2026-07-24T10:00:00.000Z',
        }),
        makeTask({
          id: '00000000-0000-4000-8000-000000000252',
          title: 'Leftover terminal work',
          status: 'next',
          projectId: completedProjectId,
          priority: 4,
          dueAt: '2026-07-23T10:00:00.000Z',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);

    const focus = await service.execute('focus.today', {}, execution('focus-overdue'));
    const data = dataOf<{
      candidateCount: number;
      recommended: Array<{ item: ProductivityTask; reasonCodes: string[] }>;
    }>(focus);

    expect(data.candidateCount).toBe(1);
    expect(data.recommended[0]).toMatchObject({
      item: { title: 'Late this morning' },
      reasonCodes: ['overdue'],
    });
  });

  test('builds current state and focus from the complete uncapped snapshot', async () => {
    const tasks = Array.from({ length: 125 }, (_, index) => makeTask({
      id: generatedUuid(index + 400),
      title: `Snapshot task ${index + 1}`,
      status: 'next',
      priority: index === 124 ? 4 : 0,
    }));
    const service = new ProductivityService(
      new InMemoryProductivityRepository({ tasks }),
      () => NOW,
    );

    const state = await service.execute(
      'state.current',
      {},
      execution('state-uncapped'),
    );
    const focus = await service.execute(
      'focus.today',
      {},
      execution('focus-uncapped'),
    );

    expect(state.data).toMatchObject({
      summary: {
        tasks: {
          open: 125,
          next: 125,
        },
      },
      focus: {
        candidateCount: 125,
      },
    });
    const focusData = dataOf<{
      candidateCount: number;
      recommended: Array<{ item: ProductivityTask }>;
    }>(focus);
    expect(focusData.candidateCount).toBe(125);
    expect(focusData.recommended[0]?.item.title).toBe('Snapshot task 125');
  });

  test('returns explicit persistence wording and never exposes a response key named exactly task', async () => {
    const repository = new InMemoryProductivityRepository({
      tasks: [
        makeTask({
          id: TASK_INBOX_ID,
          title: 'Finish budget',
          status: 'next',
        }),
      ],
      projects: [
        makeProject({
          id: PROJECT_ATLAS_ID,
          title: 'Project Atlas',
          status: 'active',
        }),
      ],
    });
    const service = new ProductivityService(repository, () => NOW);
    const responses = [
      await service.execute(
        'capture.add',
        { text: 'Loose thought', idempotencyKey: 'wording-capture' },
        execution('wording-capture'),
      ),
      await service.execute(
        'task.create',
        { title: 'Write brief', idempotencyKey: 'wording-create' },
        execution('wording-create'),
      ),
      await service.execute(
        'task.complete',
        { task: TASK_INBOX_ID, idempotencyKey: 'wording-complete' },
        execution('wording-complete'),
      ),
      await service.execute(
        'project.advance',
        {
          project: PROJECT_ATLAS_ID,
          nextAction: 'Confirm launch owner',
          idempotencyKey: 'wording-advance',
        },
        execution('wording-advance'),
      ),
      await service.execute(
        'knowledge.store',
        {
          title: 'Decision',
          content: 'Ship behind a feature flag.',
          idempotencyKey: 'wording-note',
        },
        execution('wording-note'),
      ),
      await service.execute(
        'review.record',
        {
          kind: 'daily',
          summary: 'Made progress.',
          idempotencyKey: 'wording-review',
        },
        execution('wording-review'),
      ),
    ];

    expect(responses.map((response) => response.effect?.message)).toEqual([
      'Captured “Loose thought” in your inbox.',
      'Created “Write brief”.',
      'Completed “Finish budget”.',
      'Added the next action “Confirm launch owner” to “Project Atlas”.',
      'Stored note “Decision”.',
      'Recorded your daily review for 2026-07-24.',
    ]);
    for (const response of responses) {
      expect(response).toMatchObject({
        ok: true,
        persisted: true,
        replayed: false,
        changed: true,
      });
      expect(containsExactTaskKey(response)).toBe(false);
    }

    const state = await service.execute('state.current', {}, execution('wording-state'));
    expect(containsExactTaskKey(state)).toBe(false);
    const advanceData = dataOf<Record<string, unknown>>(responses[3]);
    expect(advanceData).toHaveProperty('nextAction');
    expect(advanceData).not.toHaveProperty('task');
  });

  test('propagates idempotency keys, replays identical commands, and rejects key reuse', async () => {
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => NOW);
    const payload = {
      title: 'Create once',
      priority: 2,
      idempotencyKey: 'task-create-once',
    };

    const first = await service.execute(
      'task.create',
      payload,
      execution('idempotency-first'),
    );
    const replay = await service.execute(
      'task.create',
      payload,
      execution('idempotency-replay'),
    );

    expect(first).toMatchObject({
      persisted: true,
      replayed: false,
      changed: true,
    });
    expect(replay).toMatchObject({
      persisted: true,
      replayed: true,
      changed: false,
    });
    expect(dataOf<{ item: ProductivityTask }>(replay).item.id).toBe(
      dataOf<{ item: ProductivityTask }>(first).item.id,
    );
    expect(repository.createTaskExecutions).toBe(1);
    expect(repository.tasks).toHaveLength(1);
    expect(repository.commands.map((command) => command.idempotencyKey)).toEqual([
      'task-create-once',
      'task-create-once',
    ]);

    await expectProductivityError(
      service.execute(
        'task.create',
        {
          ...payload,
          title: 'Different semantic command',
        },
        execution('idempotency-conflict'),
      ),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(repository.createTaskExecutions).toBe(1);
    expect(repository.tasks).toHaveLength(1);
  });

  test('gives the gateway idempotency header precedence and rejects body mismatches', async () => {
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => NOW);

    const created = await service.execute(
      'task.create',
      { title: 'Header-keyed task' },
      execution('header-keyed-request', 'gateway-retry-key'),
    );
    expect(created).toMatchObject({
      persisted: true,
      replayed: false,
      changed: true,
    });
    expect(repository.commands[0]?.idempotencyKey).toBe('gateway-retry-key');

    await expectProductivityError(
      service.execute(
        'task.create',
        {
          title: 'Must not execute',
          idempotencyKey: 'body-key',
        },
        execution('mismatched-key-request', 'header-key'),
      ),
      'IDEMPOTENCY_CONFLICT',
    );
    expect(repository.tasks).toHaveLength(1);
    expect(repository.commands).toHaveLength(1);
  });

  test('rejects mismatched idempotency keys before resolving a linked project', async () => {
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => NOW);

    await expectProductivityError(
      service.execute(
        'capture.add',
        {
          text: 'Must not read storage',
          projectId: PROJECT_ATLAS_ID,
          idempotencyKey: 'body-key',
        },
        execution('mismatched-project-key', 'header-key'),
      ),
      'IDEMPOTENCY_CONFLICT',
    );

    expect(repository.projectReferenceReads).toBe(0);
    expect(repository.commands).toHaveLength(0);
  });

  test('replays an undated review across midnight using the original semantic request', async () => {
    let currentTime = new Date('2026-07-24T23:59:59.000Z');
    const repository = new InMemoryProductivityRepository();
    const service = new ProductivityService(repository, () => currentTime);
    const payload = {
      kind: 'daily' as const,
      summary: 'Closed the day.',
      idempotencyKey: 'daily-review-midnight',
    };

    const first = await service.execute(
      'review.record',
      payload,
      execution('review-before-midnight'),
    );
    currentTime = new Date('2026-07-25T00:00:01.000Z');
    const replay = await service.execute(
      'review.record',
      payload,
      execution('review-after-midnight'),
    );

    expect(first).toMatchObject({ replayed: false, changed: true });
    expect(replay).toMatchObject({ replayed: true, changed: false });
    expect(dataOf<{ item: ProductivityReview }>(replay).item.reviewDate).toBe('2026-07-24');
    expect(repository.reviews).toHaveLength(1);
  });
});
