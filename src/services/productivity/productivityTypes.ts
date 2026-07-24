export const PRODUCTIVITY_MODULE_NAME = 'ARCANOS:PRODUCTIVITY';

export const PRODUCTIVITY_TASK_STATUSES = [
  'inbox',
  'next',
  'scheduled',
  'waiting',
  'done',
  'cancelled'
] as const;

export const PRODUCTIVITY_PROJECT_STATUSES = [
  'active',
  'blocked',
  'on_hold',
  'completed',
  'archived'
] as const;

export const PRODUCTIVITY_REVIEW_KINDS = ['daily', 'weekly'] as const;

export const PRODUCTIVITY_ACTIONS = [
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
  'review.weekly',
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

export type ProductivityTaskStatus = (typeof PRODUCTIVITY_TASK_STATUSES)[number];
export type ProductivityProjectStatus = (typeof PRODUCTIVITY_PROJECT_STATUSES)[number];
export type ProductivityReviewKind = (typeof PRODUCTIVITY_REVIEW_KINDS)[number];
export type ProductivityAction = (typeof PRODUCTIVITY_ACTIONS)[number];
export type ProductivityReferenceType = 'task' | 'project';

export const PRODUCTIVITY_TASK_TRANSITIONS: Readonly<
  Record<ProductivityTaskStatus, readonly ProductivityTaskStatus[]>
> = {
  inbox: ['next', 'scheduled', 'waiting', 'cancelled'],
  next: ['scheduled', 'waiting', 'done', 'cancelled'],
  scheduled: ['next', 'waiting', 'done', 'cancelled'],
  waiting: ['next', 'scheduled', 'done', 'cancelled'],
  done: [],
  cancelled: []
};

export const PRODUCTIVITY_PROJECT_TRANSITIONS: Readonly<
  Record<ProductivityProjectStatus, readonly ProductivityProjectStatus[]>
> = {
  active: ['blocked', 'on_hold', 'completed', 'archived'],
  blocked: ['active', 'on_hold', 'completed', 'archived'],
  on_hold: ['active', 'blocked', 'completed', 'archived'],
  completed: ['archived'],
  archived: []
};

export interface ProductivityScope {
  principalId: string;
  workspaceId: string;
  actorKey?: string;
  requestId?: string;
  traceId?: string;
}

export interface ProductivityTask {
  id: string;
  projectId: string | null;
  title: string;
  details: string | null;
  status: ProductivityTaskStatus;
  priority: number;
  dueAt: string | null;
  deferUntil: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductivityProject {
  id: string;
  title: string;
  description: string | null;
  status: ProductivityProjectStatus;
  dueAt: string | null;
  completedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductivityNote {
  id: string;
  projectId: string | null;
  title: string | null;
  content: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProductivityReview {
  id: string;
  kind: ProductivityReviewKind;
  reviewDate: string;
  content: Record<string, unknown>;
  createdAt: string;
}

export interface ProductivityTaskListFilter {
  status?: ProductivityTaskStatus;
  projectId?: string;
  limit?: number;
}

export interface ProductivityProjectListFilter {
  status?: ProductivityProjectStatus;
  limit?: number;
}

export interface ProductivityNoteListFilter {
  query?: string;
  projectId?: string;
  limit?: number;
}

export interface ProductivityReviewListFilter {
  kind?: ProductivityReviewKind;
  limit?: number;
}

export interface ProductivityCreateTaskInput {
  title: string;
  details?: string;
  status: Exclude<ProductivityTaskStatus, 'done' | 'cancelled'>;
  projectId?: string;
  priority: number;
  dueAt?: string;
  deferUntil?: string;
}

export interface ProductivityTransitionTaskInput {
  status: ProductivityTaskStatus;
  expectedVersion?: number;
  projectId?: string;
  priority?: number;
  details?: string;
  dueAt?: string | null;
  deferUntil?: string | null;
}

export interface ProductivityCreateProjectInput {
  title: string;
  description?: string;
  dueAt?: string;
}

export interface ProductivityTransitionProjectInput {
  status: ProductivityProjectStatus;
  expectedVersion?: number;
}

export interface ProductivityAdvanceProjectInput {
  nextAction: string;
  details?: string;
  priority: number;
  dueAt?: string;
  expectedVersion?: number;
}

export interface ProductivityCreateNoteInput {
  title?: string;
  content: string;
  projectId?: string;
}

export interface ProductivityRecordReviewInput {
  kind: ProductivityReviewKind;
  reviewDate: string;
  content: Record<string, unknown>;
}

export interface ProductivityCommandContext {
  action: ProductivityAction;
  idempotencyKey: string;
  requestId?: string;
  traceId?: string;
  actorKey?: string;
  semanticRequest?: unknown;
}

export interface ProductivityMutationResult<T> {
  value: T;
  replayed: boolean;
  changed: boolean;
}

export interface ProductivityProjectAdvanceResult {
  project: ProductivityProject;
  task: ProductivityTask;
}

export interface ProductivityStateSnapshot {
  tasks: ProductivityTask[];
  projects: ProductivityProject[];
  noteCount: number;
  reviews: ProductivityReview[];
}

export interface ProductivityRepository {
  getCurrentStateSnapshot(
    scope: ProductivityScope
  ): Promise<ProductivityStateSnapshot>;
  replayCommand<T>(
    scope: ProductivityScope,
    command: ProductivityCommandContext,
    semanticRequest: unknown
  ): Promise<ProductivityMutationResult<T> | null>;
  listTasks(
    scope: ProductivityScope,
    filter?: ProductivityTaskListFilter
  ): Promise<ProductivityTask[]>;
  listProjects(
    scope: ProductivityScope,
    filter?: ProductivityProjectListFilter
  ): Promise<ProductivityProject[]>;
  listNotes(
    scope: ProductivityScope,
    filter?: ProductivityNoteListFilter
  ): Promise<ProductivityNote[]>;
  listReviews(
    scope: ProductivityScope,
    filter?: ProductivityReviewListFilter
  ): Promise<ProductivityReview[]>;
  findTasksByReference(
    scope: ProductivityScope,
    reference: string,
    limit?: number
  ): Promise<ProductivityTask[]>;
  findProjectsByReference(
    scope: ProductivityScope,
    reference: string,
    limit?: number
  ): Promise<ProductivityProject[]>;
  createTask(
    scope: ProductivityScope,
    input: ProductivityCreateTaskInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityTask>>;
  transitionTask(
    scope: ProductivityScope,
    taskId: string,
    input: ProductivityTransitionTaskInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityTask>>;
  createProject(
    scope: ProductivityScope,
    input: ProductivityCreateProjectInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProject>>;
  transitionProject(
    scope: ProductivityScope,
    projectId: string,
    input: ProductivityTransitionProjectInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProject>>;
  advanceProject(
    scope: ProductivityScope,
    projectId: string,
    input: ProductivityAdvanceProjectInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProjectAdvanceResult>>;
  createNote(
    scope: ProductivityScope,
    input: ProductivityCreateNoteInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityNote>>;
  recordReview(
    scope: ProductivityScope,
    input: ProductivityRecordReviewInput,
    command: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityReview>>;
}

export type ProductivityErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_REFERENCE'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'STALE_PLAN'
  | 'INVALID_TRANSITION'
  | 'PERMISSION_DENIED'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR';

export type ProductivityRecoveryAction =
  | 'ASK_USER'
  | 'REFRESH_AND_RETRY'
  | 'REPLAN'
  | 'FIX_INPUT'
  | 'CHANGE_IDEMPOTENCY_KEY'
  | 'CHECK_CONFIGURATION'
  | 'RETRY_LATER'
  | 'CONTACT_OPERATOR';

export class ProductivityError extends Error {
  readonly code: ProductivityErrorCode;
  readonly recoverable: boolean;
  readonly recommendedAction: ProductivityRecoveryAction;
  readonly details?: Record<string, unknown>;

  constructor(input: {
    code: ProductivityErrorCode;
    message: string;
    recoverable: boolean;
    recommendedAction: ProductivityRecoveryAction;
    details?: Record<string, unknown>;
  }) {
    super(input.message);
    this.name = 'ProductivityError';
    this.code = input.code;
    this.recoverable = input.recoverable;
    this.recommendedAction = input.recommendedAction;
    this.details = input.details;
  }
}
