import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

import { getPool } from '../client.js';
import {
  PRODUCTIVITY_ACTIONS,
  PRODUCTIVITY_PROJECT_TRANSITIONS,
  PRODUCTIVITY_PROJECT_STATUSES,
  PRODUCTIVITY_TASK_TRANSITIONS,
  PRODUCTIVITY_TASK_STATUSES,
  ProductivityError,
  type ProductivityAction,
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
  type ProductivityStateSnapshot,
  type ProductivityTask,
  type ProductivityTaskListFilter,
  type ProductivityTransitionProjectInput,
  type ProductivityTransitionTaskInput
} from '@services/productivity/productivityTypes.js';

const PRODUCTIVITY_IDEMPOTENCY_HASH_SCOPE = 'productivity-command-idempotency-v1';
const PRODUCTIVITY_REQUEST_FINGERPRINT_SCOPE = 'productivity-command-request-v1';
const PRODUCTIVITY_ADVISORY_LOCK_NAMESPACE = 'productivity.command.v1';
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const TASK_COLUMNS = `
  id,
  project_id,
  title,
  details,
  status,
  priority,
  due_at,
  defer_until,
  completed_at,
  version,
  created_at,
  updated_at
`;

const PROJECT_COLUMNS = `
  id,
  title,
  description,
  status,
  due_at,
  completed_at,
  version,
  created_at,
  updated_at
`;

const NOTE_COLUMNS = `
  id,
  project_id,
  title,
  content,
  version,
  created_at,
  updated_at
`;

const REVIEW_COLUMNS = `
  id,
  kind,
  review_date,
  content,
  created_at
`;

type TimestampValue = Date | string;

interface ProductivityTaskRow {
  id: string;
  project_id: string | null;
  title: string;
  details: string | null;
  status: string;
  priority: number | string;
  due_at: TimestampValue | null;
  defer_until: TimestampValue | null;
  completed_at: TimestampValue | null;
  version: number | string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface ProductivityProjectRow {
  id: string;
  title: string;
  description: string | null;
  status: string;
  due_at: TimestampValue | null;
  completed_at: TimestampValue | null;
  version: number | string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface ProductivityNoteRow {
  id: string;
  project_id: string | null;
  title: string | null;
  content: string;
  version: number | string;
  created_at: TimestampValue;
  updated_at: TimestampValue;
}

interface ProductivityReviewRow {
  id: string;
  kind: string;
  review_date: Date | string;
  content: unknown;
  created_at: TimestampValue;
}

interface ProductivityCommandReceiptRow {
  request_fingerprint: string;
  result: unknown;
}

interface ProductivityCountRow {
  note_count: number | string;
}

interface ProductivityEventDraft {
  aggregateType: 'task' | 'project' | 'note' | 'review';
  aggregateId: string;
  aggregateVersion: number | null;
  eventType: string;
  payload: Record<string, unknown>;
}

interface ProductivityMutationDraft<T> {
  value: T;
  events: ProductivityEventDraft[];
  changed?: boolean;
}

interface PreparedProductivityCommand {
  scope: ProductivityScope;
  command: ProductivityCommandContext;
  keyHash: string;
  requestFingerprint: string;
  lockKey: string;
}

function productivityError(input: ConstructorParameters<typeof ProductivityError>[0]): ProductivityError {
  return new ProductivityError(input);
}

function dependencyUnavailableError(): ProductivityError {
  return productivityError({
    code: 'DEPENDENCY_UNAVAILABLE',
    message: 'Productivity persistence is unavailable.',
    recoverable: true,
    recommendedAction: 'RETRY_LATER'
  });
}

function internalPersistenceError(): ProductivityError {
  return productivityError({
    code: 'INTERNAL_ERROR',
    message: 'Productivity persistence failed.',
    recoverable: true,
    recommendedAction: 'RETRY_LATER'
  });
}

function notFoundError(entity: 'task' | 'project'): ProductivityError {
  return productivityError({
    code: 'NOT_FOUND',
    message: `The requested ${entity} was not found.`,
    recoverable: true,
    recommendedAction: 'REFRESH_AND_RETRY'
  });
}

function stalePlanError(expectedVersion: number, currentVersion: number): ProductivityError {
  return productivityError({
    code: 'STALE_PLAN',
    message: 'The item changed after this command was prepared.',
    recoverable: true,
    recommendedAction: 'REPLAN',
    details: {
      expectedVersion,
      currentVersion
    }
  });
}

function idempotencyConflictError(): ProductivityError {
  return productivityError({
    code: 'IDEMPOTENCY_CONFLICT',
    message: 'The idempotency key was already used for a different command.',
    recoverable: true,
    recommendedAction: 'CHANGE_IDEMPOTENCY_KEY'
  });
}

function validationError(message: string): ProductivityError {
  return productivityError({
    code: 'VALIDATION_FAILED',
    message,
    recoverable: true,
    recommendedAction: 'FIX_INPUT'
  });
}

function invalidTransitionError(message: string): ProductivityError {
  return productivityError({
    code: 'INVALID_TRANSITION',
    message,
    recoverable: true,
    recommendedAction: 'REPLAN'
  });
}

function assertTaskCommandTransition(
  action: ProductivityAction,
  currentStatus: ProductivityTask['status'],
  requestedStatus: ProductivityTask['status']
): void {
  if (action === 'inbox.process' && currentStatus !== 'inbox') {
    throw invalidTransitionError('Only inbox tasks can be processed through inbox.process.');
  }
  if (action === 'task.complete' && requestedStatus !== 'done') {
    throw invalidTransitionError('task.complete must transition a task to done.');
  }
  if (action === 'task.defer' && requestedStatus !== 'scheduled') {
    throw invalidTransitionError('task.defer must transition a task to scheduled.');
  }
  if (
    currentStatus !== requestedStatus
    && !PRODUCTIVITY_TASK_TRANSITIONS[currentStatus].includes(requestedStatus)
  ) {
    throw invalidTransitionError(
      `Task cannot transition from ${currentStatus} to ${requestedStatus}.`
    );
  }
}

function assertProjectTransition(
  currentStatus: ProductivityProject['status'],
  requestedStatus: ProductivityProject['status']
): void {
  if (
    currentStatus !== requestedStatus
    && !PRODUCTIVITY_PROJECT_TRANSITIONS[currentStatus].includes(requestedStatus)
  ) {
    throw invalidTransitionError(
      `Project cannot transition from ${currentStatus} to ${requestedStatus}.`
    );
  }
}

function normalizeScope(scope: ProductivityScope): ProductivityScope {
  const principalId = normalizeRequiredText(scope.principalId, 'principalId', 512);
  const workspaceId = normalizeRequiredText(scope.workspaceId, 'workspaceId', 512);

  return {
    principalId,
    workspaceId,
    ...(scope.actorKey ? { actorKey: normalizeRequiredText(scope.actorKey, 'actorKey', 512) } : {}),
    ...(scope.requestId ? { requestId: normalizeRequiredText(scope.requestId, 'requestId', 512) } : {}),
    ...(scope.traceId ? { traceId: normalizeRequiredText(scope.traceId, 'traceId', 512) } : {})
  };
}

function normalizeCommand(
  command: ProductivityCommandContext,
  allowedActions: readonly ProductivityAction[]
): ProductivityCommandContext {
  if (!allowedActions.includes(command.action)) {
    throw validationError('The command action does not match the requested repository operation.');
  }

  return {
    action: command.action,
    idempotencyKey: normalizeRequiredText(command.idempotencyKey, 'idempotencyKey', 240),
    ...(command.requestId
      ? { requestId: normalizeRequiredText(command.requestId, 'requestId', 512) }
      : {}),
    ...(command.traceId
      ? { traceId: normalizeRequiredText(command.traceId, 'traceId', 512) }
      : {}),
    ...(command.actorKey
      ? { actorKey: normalizeRequiredText(command.actorKey, 'actorKey', 512) }
      : {}),
    ...(command.semanticRequest !== undefined
      ? { semanticRequest: command.semanticRequest }
      : {})
  };
}

function normalizeRequiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw validationError(`${field} must be a string.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw validationError(`${field} must contain between 1 and ${maxLength} characters.`);
  }
  return normalized;
}

function normalizeUuid(value: string, field: string): string {
  const normalized = normalizeRequiredText(value, field, 64).toLowerCase();
  if (!UUID_PATTERN.test(normalized)) {
    throw validationError(`${field} must be a UUID.`);
  }
  return normalized;
}

function normalizePriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 4) {
    throw validationError('priority must be an integer between 0 and 4.');
  }
  return value;
}

function normalizeExpectedVersion(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(value) || value < 1) {
    throw validationError('expectedVersion must be a positive integer.');
  }
  return value;
}

function normalizeTimestampInput(
  value: string | null | undefined,
  field: string
): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const normalized = normalizeRequiredText(value, field, 128);
  const parsed = new Date(normalized);
  if (!Number.isFinite(parsed.getTime())) {
    throw validationError(`${field} must be a valid ISO-8601 timestamp.`);
  }
  return parsed.toISOString();
}

function normalizeReviewDateInput(value: string): string {
  const normalized = normalizeRequiredText(value, 'reviewDate', 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    throw validationError('reviewDate must use YYYY-MM-DD format.');
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw validationError('reviewDate must be a valid calendar date.');
  }
  return normalized;
}

function normalizeLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_LIST_LIMIT;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw validationError('limit must be a positive integer.');
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function normalizeTimestamp(value: TimestampValue | null, _field: string): string | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw internalPersistenceError();
  }
  return parsed.toISOString();
}

function normalizeReviewDate(value: Date | string): string {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) {
      throw internalPersistenceError();
    }
    return value.toISOString().slice(0, 10);
  }
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return value;
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw internalPersistenceError();
  }
  return parsed.toISOString().slice(0, 10);
}

function normalizeVersion(value: number | string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw internalPersistenceError();
  }
  return normalized;
}

function normalizeCount(value: number | string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(normalized) || normalized < 0) {
    throw internalPersistenceError();
  }
  return normalized;
}

function normalizeRowPriority(value: number | string): number {
  const normalized = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(normalized) || normalized < 0 || normalized > 4) {
    throw internalPersistenceError();
  }
  return normalized;
}

function normalizeTaskRow(row: ProductivityTaskRow): ProductivityTask {
  if (!(PRODUCTIVITY_TASK_STATUSES as readonly string[]).includes(row.status)) {
    throw internalPersistenceError();
  }
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    details: row.details,
    status: row.status as ProductivityTask['status'],
    priority: normalizeRowPriority(row.priority),
    dueAt: normalizeTimestamp(row.due_at, 'due_at'),
    deferUntil: normalizeTimestamp(row.defer_until, 'defer_until'),
    completedAt: normalizeTimestamp(row.completed_at, 'completed_at'),
    version: normalizeVersion(row.version),
    createdAt: normalizeTimestamp(row.created_at, 'created_at')!,
    updatedAt: normalizeTimestamp(row.updated_at, 'updated_at')!
  };
}

function normalizeProjectRow(row: ProductivityProjectRow): ProductivityProject {
  if (!(PRODUCTIVITY_PROJECT_STATUSES as readonly string[]).includes(row.status)) {
    throw internalPersistenceError();
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status as ProductivityProject['status'],
    dueAt: normalizeTimestamp(row.due_at, 'due_at'),
    completedAt: normalizeTimestamp(row.completed_at, 'completed_at'),
    version: normalizeVersion(row.version),
    createdAt: normalizeTimestamp(row.created_at, 'created_at')!,
    updatedAt: normalizeTimestamp(row.updated_at, 'updated_at')!
  };
}

function normalizeNoteRow(row: ProductivityNoteRow): ProductivityNote {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    content: row.content,
    version: normalizeVersion(row.version),
    createdAt: normalizeTimestamp(row.created_at, 'created_at')!,
    updatedAt: normalizeTimestamp(row.updated_at, 'updated_at')!
  };
}

function normalizeJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return normalizeJsonObject(JSON.parse(value));
    } catch {
      throw internalPersistenceError();
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw internalPersistenceError();
  }
  return value as Record<string, unknown>;
}

function normalizeReviewRow(row: ProductivityReviewRow): ProductivityReview {
  if (row.kind !== 'daily' && row.kind !== 'weekly') {
    throw internalPersistenceError();
  }
  return {
    id: row.id,
    kind: row.kind,
    reviewDate: normalizeReviewDate(row.review_date),
    content: normalizeJsonObject(row.content),
    createdAt: normalizeTimestamp(row.created_at, 'created_at')!
  };
}

function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw validationError('Command values must contain only finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => canonicalizeJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw validationError('Command values must be JSON-serializable.');
}

function hashScopedValue(scope: string, value: string): string {
  return createHash('sha256')
    .update(scope, 'utf8')
    .update('\0', 'utf8')
    .update(value, 'utf8')
    .digest('hex');
}

function fingerprintCommand(action: ProductivityAction, semanticRequest: unknown): string {
  return hashScopedValue(
    PRODUCTIVITY_REQUEST_FINGERPRINT_SCOPE,
    canonicalizeJson({
      action,
      request: semanticRequest
    })
  );
}

function prepareCommand(
  rawScope: ProductivityScope,
  rawCommand: ProductivityCommandContext,
  allowedActions: readonly ProductivityAction[],
  defaultSemanticRequest: unknown
): PreparedProductivityCommand {
  const scope = normalizeScope(rawScope);
  const command = normalizeCommand(rawCommand, allowedActions);
  const semanticRequest = command.semanticRequest === undefined
    ? defaultSemanticRequest
    : command.semanticRequest;
  const keyHash = hashScopedValue(PRODUCTIVITY_IDEMPOTENCY_HASH_SCOPE, command.idempotencyKey);
  const requestFingerprint = fingerprintCommand(command.action, semanticRequest);
  const lockKey = hashScopedValue(
    PRODUCTIVITY_ADVISORY_LOCK_NAMESPACE,
    canonicalizeJson({
      principalId: scope.principalId,
      workspaceId: scope.workspaceId,
      action: command.action,
      keyHash
    })
  );

  return {
    scope,
    command,
    keyHash,
    requestFingerprint,
    lockKey
  };
}

function serializeJson(value: unknown): string {
  const canonical = canonicalizeJson(value);
  return canonical;
}

function readReceiptValue<T>(result: unknown): T {
  const normalized = normalizeJsonObject(result);
  if (!Object.prototype.hasOwnProperty.call(normalized, 'value')) {
    throw internalPersistenceError();
  }
  return normalized.value as T;
}

async function acquireCommandLock(
  client: PoolClient,
  prepared: PreparedProductivityCommand
): Promise<void> {
  await client.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [PRODUCTIVITY_ADVISORY_LOCK_NAMESPACE, prepared.lockKey]
  );
}

async function readCommandReceipt<T>(
  client: PoolClient,
  prepared: PreparedProductivityCommand
): Promise<ProductivityMutationResult<T> | null> {
  const receiptResult = await client.query<ProductivityCommandReceiptRow>(
    `SELECT request_fingerprint, result
     FROM productivity_command_receipts
     WHERE owner_principal_id = $1
       AND workspace_id = $2
       AND action = $3
       AND idempotency_key_hash = $4
       AND expires_at > NOW()
     LIMIT 1`,
    [
      prepared.scope.principalId,
      prepared.scope.workspaceId,
      prepared.command.action,
      prepared.keyHash
    ]
  );
  const receipt = receiptResult.rows[0];
  if (!receipt) {
    return null;
  }
  if (receipt.request_fingerprint !== prepared.requestFingerprint) {
    throw idempotencyConflictError();
  }
  return {
    value: readReceiptValue<T>(receipt.result),
    replayed: true,
    changed: false
  };
}

async function appendProductivityEvent(
  client: PoolClient,
  scope: ProductivityScope,
  command: ProductivityCommandContext,
  event: ProductivityEventDraft
): Promise<void> {
  await client.query(
    `INSERT INTO productivity_events (
       owner_principal_id,
       workspace_id,
       aggregate_type,
       aggregate_id,
       aggregate_version,
       event_type,
       payload,
       actor_principal_id,
       request_id,
       trace_id
     )
     VALUES ($1, $2, $3, $4::uuid, $5, $6, $7::jsonb, $8, $9, $10)`,
    [
      scope.principalId,
      scope.workspaceId,
      event.aggregateType,
      event.aggregateId,
      event.aggregateVersion,
      event.eventType,
      serializeJson(event.payload),
      scope.principalId,
      command.requestId ?? scope.requestId ?? null,
      command.traceId ?? scope.traceId ?? null
    ]
  );
}

async function assertProjectInScope(
  client: PoolClient,
  scope: ProductivityScope,
  projectId: string
): Promise<void> {
  const result = await client.query(
    `SELECT 1
     FROM productivity_projects
     WHERE owner_principal_id = $1
       AND workspace_id = $2
       AND id = $3::uuid
     LIMIT 1`,
    [scope.principalId, scope.workspaceId, projectId]
  );
  if (result.rowCount !== 1) {
    throw notFoundError('project');
  }
}

async function assertAssignableProjectInScope(
  client: PoolClient,
  scope: ProductivityScope,
  projectId: string
): Promise<void> {
  const result = await client.query<{ status: string }>(
    `SELECT status
     FROM productivity_projects
     WHERE owner_principal_id = $1
       AND workspace_id = $2
       AND id = $3::uuid
     FOR UPDATE`,
    [scope.principalId, scope.workspaceId, projectId]
  );
  const project = result.rows[0];
  if (!project) {
    throw notFoundError('project');
  }
  if (!(PRODUCTIVITY_PROJECT_STATUSES as readonly string[]).includes(project.status)) {
    throw internalPersistenceError();
  }
  if (project.status === 'completed' || project.status === 'archived') {
    throw invalidTransitionError('Tasks cannot be assigned to completed or archived projects.');
  }
}

export class PostgresProductivityRepository implements ProductivityRepository {
  constructor(private readonly configuredPool?: Pool) {}

  private resolvePool(): Pool {
    const pool = this.configuredPool ?? getPool();
    if (!pool) {
      throw dependencyUnavailableError();
    }
    return pool;
  }

  private async read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ProductivityError) {
        throw error;
      }
      throw dependencyUnavailableError();
    }
  }

  private async runCommand<T>(
    rawScope: ProductivityScope,
    rawCommand: ProductivityCommandContext,
    allowedActions: readonly ProductivityAction[],
    semanticRequest: unknown,
    mutation: (
      client: PoolClient,
      scope: ProductivityScope,
      command: ProductivityCommandContext
    ) => Promise<ProductivityMutationDraft<T>>
  ): Promise<ProductivityMutationResult<T>> {
    const prepared = prepareCommand(
      rawScope,
      rawCommand,
      allowedActions,
      semanticRequest
    );
    const client = await this.resolvePool().connect().catch(() => {
      throw dependencyUnavailableError();
    });

    try {
      await client.query('BEGIN');
      await acquireCommandLock(client, prepared);
      const replay = await readCommandReceipt<T>(client, prepared);
      if (replay) {
        await client.query('COMMIT');
        return replay;
      }

      const draft = await mutation(client, prepared.scope, prepared.command);
      for (const event of draft.events) {
        await appendProductivityEvent(client, prepared.scope, prepared.command, event);
      }
      await client.query(
        `WITH expired_receipts AS (
           DELETE FROM productivity_command_receipts
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND expires_at <= NOW()
             AND NOT (action = $3 AND idempotency_key_hash = $4)
         )
         INSERT INTO productivity_command_receipts (
           owner_principal_id,
           workspace_id,
           action,
           idempotency_key_hash,
           request_fingerprint,
           result,
           expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW() + INTERVAL '30 days')
         ON CONFLICT (owner_principal_id, workspace_id, action, idempotency_key_hash)
         DO UPDATE SET
           request_fingerprint = EXCLUDED.request_fingerprint,
           result = EXCLUDED.result,
           created_at = NOW(),
           expires_at = NOW() + INTERVAL '30 days'
         WHERE productivity_command_receipts.expires_at <= NOW()`,
        [
          prepared.scope.principalId,
          prepared.scope.workspaceId,
          prepared.command.action,
          prepared.keyHash,
          prepared.requestFingerprint,
          serializeJson({ value: draft.value })
        ]
      );
      await client.query('COMMIT');
      return {
        value: draft.value,
        replayed: false,
        changed: draft.changed ?? true
      };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original persistence error remains authoritative.
      }
      if (error instanceof ProductivityError) {
        throw error;
      }
      throw internalPersistenceError();
    } finally {
      client.release();
    }
  }

  async replayCommand<T>(
    rawScope: ProductivityScope,
    rawCommand: ProductivityCommandContext,
    semanticRequest: unknown
  ): Promise<ProductivityMutationResult<T> | null> {
    const prepared = prepareCommand(
      rawScope,
      { ...rawCommand, semanticRequest },
      PRODUCTIVITY_ACTIONS,
      semanticRequest
    );
    const client = await this.resolvePool().connect().catch(() => {
      throw dependencyUnavailableError();
    });

    try {
      await client.query('BEGIN');
      await acquireCommandLock(client, prepared);
      const replay = await readCommandReceipt<T>(client, prepared);
      await client.query('COMMIT');
      return replay;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original persistence error remains authoritative.
      }
      if (error instanceof ProductivityError) {
        throw error;
      }
      throw internalPersistenceError();
    } finally {
      client.release();
    }
  }

  async getCurrentStateSnapshot(
    rawScope: ProductivityScope
  ): Promise<ProductivityStateSnapshot> {
    const scope = normalizeScope(rawScope);
    const client = await this.resolvePool().connect().catch(() => {
      throw dependencyUnavailableError();
    });

    try {
      await client.query(
        'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
      );
      const taskResult = await client.query<ProductivityTaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM productivity_tasks
         WHERE owner_principal_id = $1
           AND workspace_id = $2
         ORDER BY
           CASE status
             WHEN 'next' THEN 0
             WHEN 'scheduled' THEN 1
             WHEN 'waiting' THEN 2
             WHEN 'inbox' THEN 3
             ELSE 4
           END,
           due_at ASC NULLS LAST,
           updated_at DESC,
           id`,
        [scope.principalId, scope.workspaceId]
      );
      const projectResult = await client.query<ProductivityProjectRow>(
        `SELECT ${PROJECT_COLUMNS}
         FROM productivity_projects
         WHERE owner_principal_id = $1
           AND workspace_id = $2
         ORDER BY updated_at DESC, id`,
        [scope.principalId, scope.workspaceId]
      );
      const noteCountResult = await client.query<ProductivityCountRow>(
        `SELECT COUNT(*) AS note_count
         FROM productivity_notes
         WHERE owner_principal_id = $1
           AND workspace_id = $2`,
        [scope.principalId, scope.workspaceId]
      );
      const reviewResult = await client.query<ProductivityReviewRow>(
        `SELECT DISTINCT ON (kind) ${REVIEW_COLUMNS}
         FROM productivity_reviews
         WHERE owner_principal_id = $1
           AND workspace_id = $2
         ORDER BY kind, review_date DESC, created_at DESC, id`,
        [scope.principalId, scope.workspaceId]
      );
      const noteCountRow = noteCountResult.rows[0];
      if (!noteCountRow) {
        throw internalPersistenceError();
      }
      const snapshot = {
        tasks: taskResult.rows.map(normalizeTaskRow),
        projects: projectResult.rows.map(normalizeProjectRow),
        noteCount: normalizeCount(noteCountRow.note_count),
        reviews: reviewResult.rows.map(normalizeReviewRow)
      };
      await client.query('COMMIT');
      return snapshot;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The original persistence error remains authoritative.
      }
      if (error instanceof ProductivityError) {
        throw error;
      }
      throw dependencyUnavailableError();
    } finally {
      client.release();
    }
  }

  async listTasks(
    rawScope: ProductivityScope,
    filter: ProductivityTaskListFilter = {}
  ): Promise<ProductivityTask[]> {
    const scope = normalizeScope(rawScope);
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [scope.principalId, scope.workspaceId];
    const conditions = [
      'owner_principal_id = $1',
      'workspace_id = $2'
    ];
    if (filter.status !== undefined) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }
    if (filter.projectId !== undefined) {
      values.push(normalizeUuid(filter.projectId, 'projectId'));
      conditions.push(`project_id = $${values.length}::uuid`);
    }
    values.push(limit);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityTaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM productivity_tasks
         WHERE ${conditions.join(' AND ')}
         ORDER BY
           CASE status
             WHEN 'next' THEN 0
             WHEN 'scheduled' THEN 1
             WHEN 'waiting' THEN 2
             WHEN 'inbox' THEN 3
             ELSE 4
           END,
           due_at ASC NULLS LAST,
           updated_at DESC,
           id
         LIMIT $${values.length}`,
        values
      );
      return result.rows.map(normalizeTaskRow);
    });
  }

  async listProjects(
    rawScope: ProductivityScope,
    filter: ProductivityProjectListFilter = {}
  ): Promise<ProductivityProject[]> {
    const scope = normalizeScope(rawScope);
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [scope.principalId, scope.workspaceId];
    const conditions = [
      'owner_principal_id = $1',
      'workspace_id = $2'
    ];
    if (filter.status !== undefined) {
      values.push(filter.status);
      conditions.push(`status = $${values.length}`);
    }
    values.push(limit);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityProjectRow>(
        `SELECT ${PROJECT_COLUMNS}
         FROM productivity_projects
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, id
         LIMIT $${values.length}`,
        values
      );
      return result.rows.map(normalizeProjectRow);
    });
  }

  async listNotes(
    rawScope: ProductivityScope,
    filter: ProductivityNoteListFilter = {}
  ): Promise<ProductivityNote[]> {
    const scope = normalizeScope(rawScope);
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [scope.principalId, scope.workspaceId];
    const conditions = [
      'owner_principal_id = $1',
      'workspace_id = $2'
    ];
    if (filter.query !== undefined) {
      const query = normalizeRequiredText(filter.query, 'query', 500).toLocaleLowerCase('en-US');
      values.push(query);
      conditions.push(
        `strpos(lower(COALESCE(title, '') || ' ' || content), $${values.length}) > 0`
      );
    }
    if (filter.projectId !== undefined) {
      values.push(normalizeUuid(filter.projectId, 'projectId'));
      conditions.push(`project_id = $${values.length}::uuid`);
    }
    values.push(limit);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityNoteRow>(
        `SELECT ${NOTE_COLUMNS}
         FROM productivity_notes
         WHERE ${conditions.join(' AND ')}
         ORDER BY updated_at DESC, id
         LIMIT $${values.length}`,
        values
      );
      return result.rows.map(normalizeNoteRow);
    });
  }

  async listReviews(
    rawScope: ProductivityScope,
    filter: ProductivityReviewListFilter = {}
  ): Promise<ProductivityReview[]> {
    const scope = normalizeScope(rawScope);
    const limit = normalizeLimit(filter.limit);
    const values: unknown[] = [scope.principalId, scope.workspaceId];
    const conditions = [
      'owner_principal_id = $1',
      'workspace_id = $2'
    ];
    if (filter.kind !== undefined) {
      values.push(filter.kind);
      conditions.push(`kind = $${values.length}`);
    }
    values.push(limit);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityReviewRow>(
        `SELECT ${REVIEW_COLUMNS}
         FROM productivity_reviews
         WHERE ${conditions.join(' AND ')}
         ORDER BY review_date DESC, created_at DESC, id
         LIMIT $${values.length}`,
        values
      );
      return result.rows.map(normalizeReviewRow);
    });
  }

  async findTasksByReference(
    rawScope: ProductivityScope,
    reference: string,
    requestedLimit?: number
  ): Promise<ProductivityTask[]> {
    const scope = normalizeScope(rawScope);
    const normalizedReference = normalizeRequiredText(reference, 'reference', 240);
    const foldedReference = normalizedReference.toLocaleLowerCase('en-US');
    const limit = normalizeLimit(requestedLimit ?? 10);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityTaskRow>(
        `SELECT ${TASK_COLUMNS}
         FROM productivity_tasks
         WHERE owner_principal_id = $1
           AND workspace_id = $2
           AND (
             id::text = $3
             OR lower(title) = $4
             OR strpos(lower(title), $4) = 1
             OR strpos(lower(title), $4) > 0
           )
         ORDER BY
           CASE
             WHEN id::text = $3 THEN 0
             WHEN lower(title) = $4 THEN 1
             WHEN strpos(lower(title), $4) = 1 THEN 2
             ELSE 3
           END,
           updated_at DESC,
           id
         LIMIT $5`,
        [scope.principalId, scope.workspaceId, foldedReference, foldedReference, limit]
      );
      return result.rows.map(normalizeTaskRow);
    });
  }

  async findProjectsByReference(
    rawScope: ProductivityScope,
    reference: string,
    requestedLimit?: number
  ): Promise<ProductivityProject[]> {
    const scope = normalizeScope(rawScope);
    const normalizedReference = normalizeRequiredText(reference, 'reference', 240);
    const foldedReference = normalizedReference.toLocaleLowerCase('en-US');
    const limit = normalizeLimit(requestedLimit ?? 10);

    return this.read(async () => {
      const result = await this.resolvePool().query<ProductivityProjectRow>(
        `SELECT ${PROJECT_COLUMNS}
         FROM productivity_projects
         WHERE owner_principal_id = $1
           AND workspace_id = $2
           AND (
             id::text = $3
             OR lower(title) = $4
             OR strpos(lower(title), $4) = 1
             OR strpos(lower(title), $4) > 0
           )
         ORDER BY
           CASE
             WHEN id::text = $3 THEN 0
             WHEN lower(title) = $4 THEN 1
             WHEN strpos(lower(title), $4) = 1 THEN 2
             ELSE 3
           END,
           updated_at DESC,
           id
         LIMIT $5`,
        [scope.principalId, scope.workspaceId, foldedReference, foldedReference, limit]
      );
      return result.rows.map(normalizeProjectRow);
    });
  }

  async createTask(
    rawScope: ProductivityScope,
    input: ProductivityCreateTaskInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityTask>> {
    const normalizedInput: ProductivityCreateTaskInput = {
      title: normalizeRequiredText(input.title, 'title', 240),
      status: input.status,
      priority: normalizePriority(input.priority),
      ...(input.details !== undefined
        ? { details: normalizeRequiredText(input.details, 'details', 20_000) }
        : {}),
      ...(input.projectId !== undefined
        ? { projectId: normalizeUuid(input.projectId, 'projectId') }
        : {}),
      ...(input.dueAt !== undefined
        ? { dueAt: normalizeTimestampInput(input.dueAt, 'dueAt')! }
        : {}),
      ...(input.deferUntil !== undefined
        ? { deferUntil: normalizeTimestampInput(input.deferUntil, 'deferUntil')! }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['capture.add', 'task.create'],
      normalizedInput,
      async (client, scope) => {
        if (normalizedInput.projectId) {
          await assertAssignableProjectInScope(client, scope, normalizedInput.projectId);
        }
        const result = await client.query<ProductivityTaskRow>(
          `INSERT INTO productivity_tasks (
             owner_principal_id,
             workspace_id,
             project_id,
             title,
             details,
             status,
             priority,
             due_at,
             defer_until
           )
           VALUES ($1, $2, $3::uuid, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz)
           RETURNING ${TASK_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedInput.projectId ?? null,
            normalizedInput.title,
            normalizedInput.details ?? null,
            normalizedInput.status,
            normalizedInput.priority,
            normalizedInput.dueAt ?? null,
            normalizedInput.deferUntil ?? null
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw internalPersistenceError();
        }
        const task = normalizeTaskRow(row);
        return {
          value: task,
          events: [{
            aggregateType: 'task',
            aggregateId: task.id,
            aggregateVersion: task.version,
            eventType: 'task.created',
            payload: {
              status: task.status,
              projectId: task.projectId,
              priority: task.priority
            }
          }]
        };
      }
    );
  }

  async transitionTask(
    rawScope: ProductivityScope,
    taskId: string,
    input: ProductivityTransitionTaskInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityTask>> {
    const normalizedTaskId = normalizeUuid(taskId, 'taskId');
    const normalizedInput: ProductivityTransitionTaskInput = {
      status: input.status,
      ...(input.expectedVersion !== undefined
        ? { expectedVersion: normalizeExpectedVersion(input.expectedVersion) }
        : {}),
      ...(input.projectId !== undefined
        ? { projectId: normalizeUuid(input.projectId, 'projectId') }
        : {}),
      ...(input.priority !== undefined ? { priority: normalizePriority(input.priority) } : {}),
      ...(input.details !== undefined
        ? { details: normalizeRequiredText(input.details, 'details', 20_000) }
        : {}),
      ...(input.dueAt !== undefined
        ? { dueAt: normalizeTimestampInput(input.dueAt, 'dueAt') }
        : {}),
      ...(input.deferUntil !== undefined
        ? { deferUntil: normalizeTimestampInput(input.deferUntil, 'deferUntil') }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['inbox.process', 'task.complete', 'task.defer', 'task.transition'],
      { taskId: normalizedTaskId, input: normalizedInput },
      async (client, scope, command) => {
        const currentResult = await client.query<ProductivityTaskRow>(
          `SELECT ${TASK_COLUMNS}
           FROM productivity_tasks
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
           FOR UPDATE`,
          [scope.principalId, scope.workspaceId, normalizedTaskId]
        );
        const currentRow = currentResult.rows[0];
        if (!currentRow) {
          throw notFoundError('task');
        }
        const current = normalizeTaskRow(currentRow);
        if (
          normalizedInput.expectedVersion !== undefined
          && normalizedInput.expectedVersion !== current.version
        ) {
          throw stalePlanError(normalizedInput.expectedVersion, current.version);
        }
        assertTaskCommandTransition(command.action, current.status, normalizedInput.status);
        if (
          normalizedInput.projectId
          && normalizedInput.projectId !== current.projectId
        ) {
          await assertAssignableProjectInScope(client, scope, normalizedInput.projectId);
        }

        const nextProjectId = normalizedInput.projectId ?? current.projectId;
        const nextDetails = normalizedInput.details ?? current.details;
        const nextPriority = normalizedInput.priority ?? current.priority;
        const nextDueAt = normalizedInput.dueAt === undefined
          ? current.dueAt
          : normalizedInput.dueAt;
        const nextDeferUntil = normalizedInput.deferUntil === undefined
          ? current.deferUntil
          : normalizedInput.deferUntil;
        const hasChanges =
          normalizedInput.status !== current.status
          || nextProjectId !== current.projectId
          || nextDetails !== current.details
          || nextPriority !== current.priority
          || nextDueAt !== current.dueAt
          || nextDeferUntil !== current.deferUntil;
        if (!hasChanges) {
          return {
            value: current,
            events: [],
            changed: false
          };
        }
        const updatedResult = await client.query<ProductivityTaskRow>(
          `UPDATE productivity_tasks
           SET project_id = $4::uuid,
               details = $5,
               status = $6,
               priority = $7,
               due_at = $8::timestamptz,
               defer_until = $9::timestamptz,
               completed_at = CASE
                 WHEN $6 = 'done' THEN COALESCE(completed_at, NOW())
                 ELSE NULL
               END,
               version = version + 1,
               updated_at = NOW()
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
             AND version = $10
           RETURNING ${TASK_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedTaskId,
            nextProjectId,
            nextDetails,
            normalizedInput.status,
            nextPriority,
            nextDueAt,
            nextDeferUntil,
            current.version
          ]
        );
        const updatedRow = updatedResult.rows[0];
        if (!updatedRow) {
          throw stalePlanError(current.version, current.version + 1);
        }
        const task = normalizeTaskRow(updatedRow);
        return {
          value: task,
          events: [{
            aggregateType: 'task',
            aggregateId: task.id,
            aggregateVersion: task.version,
            eventType: 'task.transitioned',
            payload: {
              fromStatus: current.status,
              toStatus: task.status,
              projectId: task.projectId
            }
          }]
        };
      }
    );
  }

  async createProject(
    rawScope: ProductivityScope,
    input: ProductivityCreateProjectInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProject>> {
    const normalizedInput: ProductivityCreateProjectInput = {
      title: normalizeRequiredText(input.title, 'title', 240),
      ...(input.description !== undefined
        ? { description: normalizeRequiredText(input.description, 'description', 20_000) }
        : {}),
      ...(input.dueAt !== undefined
        ? { dueAt: normalizeTimestampInput(input.dueAt, 'dueAt')! }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['project.create'],
      normalizedInput,
      async (client, scope) => {
        const result = await client.query<ProductivityProjectRow>(
          `INSERT INTO productivity_projects (
             owner_principal_id,
             workspace_id,
             title,
             description,
             due_at
           )
           VALUES ($1, $2, $3, $4, $5::timestamptz)
           RETURNING ${PROJECT_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedInput.title,
            normalizedInput.description ?? null,
            normalizedInput.dueAt ?? null
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw internalPersistenceError();
        }
        const project = normalizeProjectRow(row);
        return {
          value: project,
          events: [{
            aggregateType: 'project',
            aggregateId: project.id,
            aggregateVersion: project.version,
            eventType: 'project.created',
            payload: {
              status: project.status
            }
          }]
        };
      }
    );
  }

  async transitionProject(
    rawScope: ProductivityScope,
    projectId: string,
    input: ProductivityTransitionProjectInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProject>> {
    const normalizedProjectId = normalizeUuid(projectId, 'projectId');
    const normalizedInput: ProductivityTransitionProjectInput = {
      status: input.status,
      ...(input.expectedVersion !== undefined
        ? { expectedVersion: normalizeExpectedVersion(input.expectedVersion) }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['project.transition'],
      { projectId: normalizedProjectId, input: normalizedInput },
      async (client, scope) => {
        const currentResult = await client.query<ProductivityProjectRow>(
          `SELECT ${PROJECT_COLUMNS}
           FROM productivity_projects
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
           FOR UPDATE`,
          [scope.principalId, scope.workspaceId, normalizedProjectId]
        );
        const currentRow = currentResult.rows[0];
        if (!currentRow) {
          throw notFoundError('project');
        }
        const current = normalizeProjectRow(currentRow);
        if (
          normalizedInput.expectedVersion !== undefined
          && normalizedInput.expectedVersion !== current.version
        ) {
          throw stalePlanError(normalizedInput.expectedVersion, current.version);
        }
        assertProjectTransition(current.status, normalizedInput.status);
        if (normalizedInput.status === current.status) {
          return {
            value: current,
            events: [],
            changed: false
          };
        }

        const updatedResult = await client.query<ProductivityProjectRow>(
          `UPDATE productivity_projects
           SET status = $4,
                completed_at = CASE
                  WHEN $4 = 'completed' THEN COALESCE(completed_at, NOW())
                  WHEN $4 = 'archived' THEN completed_at
                  ELSE NULL
                END,
               version = version + 1,
               updated_at = NOW()
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
             AND version = $5
           RETURNING ${PROJECT_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedProjectId,
            normalizedInput.status,
            current.version
          ]
        );
        const updatedRow = updatedResult.rows[0];
        if (!updatedRow) {
          throw stalePlanError(current.version, current.version + 1);
        }
        const project = normalizeProjectRow(updatedRow);
        return {
          value: project,
          events: [{
            aggregateType: 'project',
            aggregateId: project.id,
            aggregateVersion: project.version,
            eventType: 'project.transitioned',
            payload: {
              fromStatus: current.status,
              toStatus: project.status
            }
          }]
        };
      }
    );
  }

  async advanceProject(
    rawScope: ProductivityScope,
    projectId: string,
    input: ProductivityAdvanceProjectInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityProjectAdvanceResult>> {
    const normalizedProjectId = normalizeUuid(projectId, 'projectId');
    const normalizedInput: ProductivityAdvanceProjectInput = {
      nextAction: normalizeRequiredText(input.nextAction, 'nextAction', 240),
      priority: normalizePriority(input.priority),
      ...(input.details !== undefined
        ? { details: normalizeRequiredText(input.details, 'details', 20_000) }
        : {}),
      ...(input.dueAt !== undefined
        ? { dueAt: normalizeTimestampInput(input.dueAt, 'dueAt')! }
        : {}),
      ...(input.expectedVersion !== undefined
        ? { expectedVersion: normalizeExpectedVersion(input.expectedVersion) }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['project.advance'],
      { projectId: normalizedProjectId, input: normalizedInput },
      async (client, scope) => {
        const currentResult = await client.query<ProductivityProjectRow>(
          `SELECT ${PROJECT_COLUMNS}
           FROM productivity_projects
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
           FOR UPDATE`,
          [scope.principalId, scope.workspaceId, normalizedProjectId]
        );
        const currentRow = currentResult.rows[0];
        if (!currentRow) {
          throw notFoundError('project');
        }
        const current = normalizeProjectRow(currentRow);
        if (
          normalizedInput.expectedVersion !== undefined
          && normalizedInput.expectedVersion !== current.version
        ) {
          throw stalePlanError(normalizedInput.expectedVersion, current.version);
        }
        if (current.status === 'completed' || current.status === 'archived') {
          throw invalidTransitionError('Completed or archived projects cannot be advanced.');
        }

        const projectResult = await client.query<ProductivityProjectRow>(
          `UPDATE productivity_projects
           SET version = version + 1,
               updated_at = NOW()
           WHERE owner_principal_id = $1
             AND workspace_id = $2
             AND id = $3::uuid
             AND version = $4
           RETURNING ${PROJECT_COLUMNS}`,
          [scope.principalId, scope.workspaceId, normalizedProjectId, current.version]
        );
        const projectRow = projectResult.rows[0];
        if (!projectRow) {
          throw stalePlanError(current.version, current.version + 1);
        }
        const taskResult = await client.query<ProductivityTaskRow>(
          `INSERT INTO productivity_tasks (
             owner_principal_id,
             workspace_id,
             project_id,
             title,
             details,
             status,
             priority,
             due_at
           )
           VALUES ($1, $2, $3::uuid, $4, $5, 'next', $6, $7::timestamptz)
           RETURNING ${TASK_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedProjectId,
            normalizedInput.nextAction,
            normalizedInput.details ?? null,
            normalizedInput.priority,
            normalizedInput.dueAt ?? null
          ]
        );
        const taskRow = taskResult.rows[0];
        if (!taskRow) {
          throw internalPersistenceError();
        }
        const project = normalizeProjectRow(projectRow);
        const task = normalizeTaskRow(taskRow);
        return {
          value: { project, task },
          events: [
            {
              aggregateType: 'project',
              aggregateId: project.id,
              aggregateVersion: project.version,
              eventType: 'project.advanced',
              payload: {
                taskId: task.id,
                status: project.status
              }
            },
            {
              aggregateType: 'task',
              aggregateId: task.id,
              aggregateVersion: task.version,
              eventType: 'task.created',
              payload: {
                status: task.status,
                projectId: project.id,
                priority: task.priority
              }
            }
          ]
        };
      }
    );
  }

  async createNote(
    rawScope: ProductivityScope,
    input: ProductivityCreateNoteInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityNote>> {
    const normalizedInput: ProductivityCreateNoteInput = {
      content: normalizeRequiredText(input.content, 'content', 100_000),
      ...(input.title !== undefined
        ? { title: normalizeRequiredText(input.title, 'title', 240) }
        : {}),
      ...(input.projectId !== undefined
        ? { projectId: normalizeUuid(input.projectId, 'projectId') }
        : {})
    };

    return this.runCommand(
      rawScope,
      rawCommand,
      ['knowledge.store'],
      normalizedInput,
      async (client, scope) => {
        if (normalizedInput.projectId) {
          await assertProjectInScope(client, scope, normalizedInput.projectId);
        }
        const result = await client.query<ProductivityNoteRow>(
          `INSERT INTO productivity_notes (
             owner_principal_id,
             workspace_id,
             project_id,
             title,
             content
           )
           VALUES ($1, $2, $3::uuid, $4, $5)
           RETURNING ${NOTE_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedInput.projectId ?? null,
            normalizedInput.title ?? null,
            normalizedInput.content
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw internalPersistenceError();
        }
        const note = normalizeNoteRow(row);
        return {
          value: note,
          events: [{
            aggregateType: 'note',
            aggregateId: note.id,
            aggregateVersion: note.version,
            eventType: 'note.created',
            payload: {
              projectId: note.projectId,
              titled: note.title !== null
            }
          }]
        };
      }
    );
  }

  async recordReview(
    rawScope: ProductivityScope,
    input: ProductivityRecordReviewInput,
    rawCommand: ProductivityCommandContext
  ): Promise<ProductivityMutationResult<ProductivityReview>> {
    const normalizedInput: ProductivityRecordReviewInput = {
      kind: input.kind,
      reviewDate: normalizeReviewDateInput(input.reviewDate),
      content: normalizeJsonObject(input.content)
    };
    const serializedContent = serializeJson(normalizedInput.content);

    return this.runCommand(
      rawScope,
      rawCommand,
      ['review.record'],
      normalizedInput,
      async (client, scope) => {
        const result = await client.query<ProductivityReviewRow>(
          `INSERT INTO productivity_reviews (
             owner_principal_id,
             workspace_id,
             kind,
             review_date,
             content
           )
           VALUES ($1, $2, $3, $4::date, $5::jsonb)
           RETURNING ${REVIEW_COLUMNS}`,
          [
            scope.principalId,
            scope.workspaceId,
            normalizedInput.kind,
            normalizedInput.reviewDate,
            serializedContent
          ]
        );
        const row = result.rows[0];
        if (!row) {
          throw internalPersistenceError();
        }
        const review = normalizeReviewRow(row);
        return {
          value: review,
          events: [{
            aggregateType: 'review',
            aggregateId: review.id,
            aggregateVersion: null,
            eventType: 'review.recorded',
            payload: {
              kind: review.kind,
              reviewDate: review.reviewDate
            }
          }]
        };
      }
    );
  }
}

export function createProductivityRepository(pool?: Pool): ProductivityRepository {
  return new PostgresProductivityRepository(pool);
}

export function getProductivityRepository(): ProductivityRepository {
  return createProductivityRepository();
}
