import { describe, expect, jest, test } from '@jest/globals';
import type { Pool, PoolClient } from 'pg';

import { PostgresProductivityRepository } from '../src/core/db/repositories/productivityRepository.js';

const SCOPE = {
  principalId: 'operator:primary',
  workspaceId: 'personal',
  actorKey: 'actor:test',
  requestId: 'request:test',
  traceId: 'trace:test'
} as const;

const TASK_ID = '10000000-0000-4000-8000-000000000001';
const PROJECT_ID = '20000000-0000-4000-8000-000000000001';

interface QueryRecord {
  sql: string;
  values: unknown[];
}

interface StoredReceipt {
  request_fingerprint: string;
  result: unknown;
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

function queryResult(rows: unknown[] = []) {
  return {
    rows,
    rowCount: rows.length
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    project_id: null,
    title: 'Approve launch budget',
    details: null,
    status: 'next',
    priority: 3,
    due_at: null,
    defer_until: null,
    completed_at: null,
    version: 1,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T12:00:00.000Z',
    ...overrides
  };
}

function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    title: 'Project Atlas',
    description: null,
    status: 'active',
    due_at: null,
    completed_at: null,
    version: 1,
    created_at: '2026-07-24T12:00:00.000Z',
    updated_at: '2026-07-24T12:00:00.000Z',
    ...overrides
  };
}

function reviewRow(overrides: Record<string, unknown> = {}) {
  return {
    id: '40000000-0000-4000-8000-000000000001',
    kind: 'daily',
    review_date: '2026-07-24',
    content: { summary: 'Ready' },
    created_at: '2026-07-24T12:00:00.000Z',
    ...overrides
  };
}

class MockProductivityPool {
  readonly queries: QueryRecord[] = [];
  readonly release = jest.fn();
  readonly connect = jest.fn(async () => this.client);
  readonly query = jest.fn(async (sql: string, values: unknown[] = []) =>
    this.handle(sql, values)
  );

  failEventInsert = false;
  currentTask: ReturnType<typeof taskRow> | null = null;
  updatedTask: ReturnType<typeof taskRow> | null = null;
  currentProject: ReturnType<typeof projectRow> | null = null;
  updatedProject: ReturnType<typeof projectRow> | null = null;
  assignmentProjectStatus: string | null = null;
  snapshotTasks: Array<ReturnType<typeof taskRow>> = [];
  snapshotProjects: Array<ReturnType<typeof projectRow>> = [];
  snapshotNoteCount = 0;
  snapshotReviews: Array<ReturnType<typeof reviewRow>> = [];
  storedReceipt: StoredReceipt | null = null;
  storedReceiptExpired = false;
  taskInsertCount = 0;
  eventInsertCount = 0;
  receiptInsertCount = 0;

  readonly client = {
    query: jest.fn(async (sql: string, values: unknown[] = []) =>
      this.handle(sql, values)
    ),
    release: this.release
  } as unknown as PoolClient;

  readonly pool = {
    connect: this.connect,
    query: this.query
  } as unknown as Pool;

  private async handle(rawSql: string, values: unknown[]) {
    const sql = normalizeSql(rawSql);
    this.queries.push({ sql, values });

    if (
      sql.startsWith('BEGIN')
      || sql === 'COMMIT'
      || sql === 'ROLLBACK'
      || sql.startsWith('SELECT pg_advisory_xact_lock(')
    ) {
      return queryResult();
    }

    if (sql.startsWith('SELECT request_fingerprint, result FROM productivity_command_receipts')) {
      return queryResult(
        this.storedReceipt && !this.storedReceiptExpired ? [this.storedReceipt] : []
      );
    }

    if (sql.startsWith('INSERT INTO productivity_tasks')) {
      this.taskInsertCount += 1;
      return queryResult([
        taskRow({
          project_id: values[2] ?? null,
          title: values[3],
          details: values[4] ?? null,
          status: values[5],
          priority: values[6],
          due_at: values[7] ?? null,
          defer_until: values[8] ?? null
        })
      ]);
    }

    if (sql.startsWith('INSERT INTO productivity_events')) {
      this.eventInsertCount += 1;
      if (this.failEventInsert) {
        throw new Error('SENTINEL_EVENT_INSERT_FAILURE');
      }
      return queryResult();
    }

    if (
      sql.startsWith('WITH expired_receipts AS')
      && sql.includes('INSERT INTO productivity_command_receipts')
    ) {
      this.receiptInsertCount += 1;
      this.storedReceiptExpired = false;
      this.storedReceipt = {
        request_fingerprint: String(values[4]),
        result: JSON.parse(String(values[5]))
      };
      return queryResult();
    }

    if (
      sql.startsWith('SELECT')
      && sql.includes('FROM productivity_tasks')
      && sql.endsWith('FOR UPDATE')
    ) {
      return queryResult(this.currentTask ? [this.currentTask] : []);
    }

    if (sql.startsWith('UPDATE productivity_tasks')) {
      return queryResult(this.updatedTask ? [this.updatedTask] : []);
    }

    if (sql.startsWith('SELECT') && sql.includes('FROM productivity_tasks')) {
      return queryResult(this.snapshotTasks);
    }

    if (
      sql.startsWith('SELECT status')
      && sql.includes('FROM productivity_projects')
      && sql.endsWith('FOR UPDATE')
    ) {
      return queryResult(
        this.assignmentProjectStatus
          ? [{ status: this.assignmentProjectStatus }]
          : []
      );
    }

    if (
      sql.startsWith('SELECT')
      && sql.includes('FROM productivity_projects')
      && sql.endsWith('FOR UPDATE')
    ) {
      return queryResult(this.currentProject ? [this.currentProject] : []);
    }

    if (sql.startsWith('UPDATE productivity_projects')) {
      return queryResult(this.updatedProject ? [this.updatedProject] : []);
    }

    if (sql.startsWith('SELECT') && sql.includes('FROM productivity_projects')) {
      return queryResult(this.snapshotProjects);
    }

    if (
      sql.startsWith('SELECT COUNT(*) AS note_count')
      && sql.includes('FROM productivity_notes')
    ) {
      return queryResult([{ note_count: String(this.snapshotNoteCount) }]);
    }

    if (sql.startsWith('SELECT') && sql.includes('FROM productivity_reviews')) {
      return queryResult(this.snapshotReviews);
    }

    throw new Error(`Unhandled repository query: ${sql}`);
  }
}

function createTaskCommand(idempotencyKey = 'task-create-key') {
  return {
    action: 'task.create' as const,
    idempotencyKey,
    requestId: 'request:command',
    traceId: 'trace:command',
    actorKey: 'actor:command'
  };
}

function createTaskInput(title = 'Approve launch budget') {
  return {
    title,
    status: 'next' as const,
    priority: 3
  };
}

describe('PostgresProductivityRepository command boundary', () => {
  test('orders mutation, outbox event, and hashed receipt atomically before commit', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);

    const result = await repository.createTask(
      SCOPE,
      createTaskInput(),
      createTaskCommand('raw-secret-idempotency-key')
    );

    expect(result).toMatchObject({
      replayed: false,
      changed: true,
      value: {
        id: TASK_ID,
        title: 'Approve launch budget',
        status: 'next'
      }
    });

    const statements = mock.queries.map(record => record.sql);
    const beginIndex = statements.indexOf('BEGIN');
    const lockIndex = statements.findIndex(sql =>
      sql.startsWith('SELECT pg_advisory_xact_lock(')
    );
    const receiptReadIndex = statements.findIndex(sql =>
      sql.startsWith('SELECT request_fingerprint, result FROM productivity_command_receipts')
    );
    const mutationIndex = statements.findIndex(sql =>
      sql.startsWith('INSERT INTO productivity_tasks')
    );
    const eventIndex = statements.findIndex(sql =>
      sql.startsWith('INSERT INTO productivity_events')
    );
    const receiptWriteIndex = statements.findIndex(sql =>
      sql.startsWith('WITH expired_receipts AS')
      && sql.includes('INSERT INTO productivity_command_receipts')
    );
    const commitIndex = statements.indexOf('COMMIT');

    expect([
      beginIndex,
      lockIndex,
      receiptReadIndex,
      mutationIndex,
      eventIndex,
      receiptWriteIndex,
      commitIndex
    ]).toEqual([...[
      beginIndex,
      lockIndex,
      receiptReadIndex,
      mutationIndex,
      eventIndex,
      receiptWriteIndex,
      commitIndex
    ]].sort((left, right) => left - right));

    const receiptWrite = mock.queries[receiptWriteIndex];
    expect(receiptWrite?.values.slice(0, 3)).toEqual([
      SCOPE.principalId,
      SCOPE.workspaceId,
      'task.create'
    ]);
    expect(receiptWrite?.values[3]).toMatch(/^[0-9a-f]{64}$/u);
    expect(receiptWrite?.values[3]).not.toBe('raw-secret-idempotency-key');
    expect(receiptWrite?.sql).toContain(
      'DELETE FROM productivity_command_receipts WHERE owner_principal_id = $1 AND workspace_id = $2 AND expires_at <= NOW() AND NOT (action = $3 AND idempotency_key_hash = $4)'
    );
    expect(receiptWrite?.sql).toContain(
      "expires_at = NOW() + INTERVAL '30 days'"
    );
    expect(mock.queries[receiptReadIndex]?.sql).toContain('AND expires_at > NOW()');

    const eventWrite = mock.queries[eventIndex];
    expect(eventWrite?.values.slice(0, 2)).toEqual([
      SCOPE.principalId,
      SCOPE.workspaceId
    ]);
    expect(mock.release).toHaveBeenCalledTimes(1);
  });

  test('replays the stored result without repeating the domain mutation or event', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);
    const command = createTaskCommand('replay-key');

    const first = await repository.createTask(SCOPE, createTaskInput(), command);
    const replay = await repository.createTask(SCOPE, createTaskInput(), command);

    expect(first.replayed).toBe(false);
    expect(replay).toEqual({
      value: first.value,
      replayed: true,
      changed: false
    });
    expect(mock.taskInsertCount).toBe(1);
    expect(mock.eventInsertCount).toBe(1);
    expect(mock.receiptInsertCount).toBe(1);
    expect(mock.queries.filter(record => record.sql === 'COMMIT')).toHaveLength(2);
    expect(mock.release).toHaveBeenCalledTimes(2);
  });

  test('rejects changed semantics under a reused key before a second mutation', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);
    const command = createTaskCommand('conflict-key');

    await repository.createTask(SCOPE, createTaskInput(), command);

    await expect(
      repository.createTask(
        SCOPE,
        createTaskInput('Send client agenda'),
        command
      )
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      recommendedAction: 'CHANGE_IDEMPOTENCY_KEY'
    });

    expect(mock.taskInsertCount).toBe(1);
    expect(mock.eventInsertCount).toBe(1);
    expect(mock.receiptInsertCount).toBe(1);
    expect(mock.queries.filter(record => record.sql === 'ROLLBACK')).toHaveLength(1);
    expect(mock.release).toHaveBeenCalledTimes(2);
  });

  test('ignores an expired receipt and replaces it in the scoped cleanup write', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);
    const command = createTaskCommand('expired-receipt-key');

    await repository.createTask(SCOPE, createTaskInput(), command);
    mock.storedReceiptExpired = true;

    const result = await repository.createTask(SCOPE, createTaskInput(), command);

    expect(result.replayed).toBe(false);
    expect(mock.taskInsertCount).toBe(2);
    expect(mock.eventInsertCount).toBe(2);
    expect(mock.receiptInsertCount).toBe(2);
    const receiptWrites = mock.queries.filter(record =>
      record.sql.startsWith('WITH expired_receipts AS')
      && record.sql.includes('INSERT INTO productivity_command_receipts')
    );
    expect(receiptWrites).toHaveLength(2);
    expect(receiptWrites[1]?.values.slice(0, 2)).toEqual([
      SCOPE.principalId,
      SCOPE.workspaceId
    ]);
  });

  test('rolls back and omits the receipt when the outbox event cannot be stored', async () => {
    const mock = new MockProductivityPool();
    mock.failEventInsert = true;
    const repository = new PostgresProductivityRepository(mock.pool);

    await expect(
      repository.createTask(
        SCOPE,
        createTaskInput(),
        createTaskCommand('rollback-key')
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      recommendedAction: 'RETRY_LATER'
    });

    const statements = mock.queries.map(record => record.sql);
    const mutationIndex = statements.findIndex(sql =>
      sql.startsWith('INSERT INTO productivity_tasks')
    );
    const eventIndex = statements.findIndex(sql =>
      sql.startsWith('INSERT INTO productivity_events')
    );
    const rollbackIndex = statements.indexOf('ROLLBACK');

    expect(mutationIndex).toBeGreaterThan(-1);
    expect(eventIndex).toBeGreaterThan(mutationIndex);
    expect(rollbackIndex).toBeGreaterThan(eventIndex);
    expect(statements).not.toContain('COMMIT');
    expect(mock.receiptInsertCount).toBe(0);
    expect(mock.release).toHaveBeenCalledTimes(1);
  });

  test('binds tenant scope in read queries instead of accepting it from filters', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);

    await repository.listTasks(SCOPE, {
      status: 'waiting',
      limit: 7
    });

    expect(mock.query).toHaveBeenCalledTimes(1);
    const read = mock.queries[0];
    expect(read?.sql).toContain('WHERE owner_principal_id = $1 AND workspace_id = $2');
    expect(read?.values).toEqual([
      SCOPE.principalId,
      SCOPE.workspaceId,
      'waiting',
      7
    ]);
    expect(mock.connect).not.toHaveBeenCalled();
  });

  test('fails stale optimistic transitions before update, event, or receipt writes', async () => {
    const mock = new MockProductivityPool();
    mock.currentTask = taskRow({
      version: 4,
      status: 'next'
    });
    const repository = new PostgresProductivityRepository(mock.pool);

    await expect(
      repository.transitionTask(
        SCOPE,
        TASK_ID,
        {
          status: 'done',
          expectedVersion: 3
        },
        {
          action: 'task.transition',
          idempotencyKey: 'stale-key'
        }
      )
    ).rejects.toMatchObject({
      code: 'STALE_PLAN',
      recommendedAction: 'REPLAN',
      details: {
        expectedVersion: 3,
        currentVersion: 4
      }
    });

    const statements = mock.queries.map(record => record.sql);
    expect(statements.some(sql => sql.startsWith('UPDATE productivity_tasks'))).toBe(false);
    expect(mock.eventInsertCount).toBe(0);
    expect(mock.receiptInsertCount).toBe(0);
    expect(statements).toContain('ROLLBACK');
    expect(statements).not.toContain('COMMIT');
    expect(mock.release).toHaveBeenCalledTimes(1);
  });

  test('replays a terminal task result before current-state lifecycle validation', async () => {
    const mock = new MockProductivityPool();
    mock.currentTask = taskRow({ status: 'next', version: 1 });
    mock.updatedTask = taskRow({
      status: 'done',
      version: 2,
      completed_at: '2026-07-24T12:05:00.000Z'
    });
    const repository = new PostgresProductivityRepository(mock.pool);
    const command = {
      action: 'task.complete' as const,
      idempotencyKey: 'complete-replay-key'
    };
    const input = {
      status: 'done' as const,
      expectedVersion: 1
    };

    const first = await repository.transitionTask(SCOPE, TASK_ID, input, command);
    mock.currentTask = mock.updatedTask;
    const replay = await repository.transitionTask(SCOPE, TASK_ID, input, command);

    expect(first).toMatchObject({ replayed: false, changed: true });
    expect(replay).toEqual({
      value: first.value,
      replayed: true,
      changed: false
    });
    expect(mock.queries.filter(record =>
      record.sql.includes('FROM productivity_tasks') && record.sql.endsWith('FOR UPDATE')
    )).toHaveLength(1);
    expect(mock.queries.filter(record =>
      record.sql.startsWith('UPDATE productivity_tasks')
    )).toHaveLength(1);
    expect(mock.eventInsertCount).toBe(1);
    expect(mock.receiptInsertCount).toBe(1);
  });

  test('rejects a concurrent terminal-state resurrection inside the locked mutation', async () => {
    const mock = new MockProductivityPool();
    mock.currentTask = taskRow({
      status: 'cancelled',
      version: 2
    });
    const repository = new PostgresProductivityRepository(mock.pool);

    await expect(
      repository.transitionTask(
        SCOPE,
        TASK_ID,
        { status: 'done' },
        {
          action: 'task.complete',
          idempotencyKey: 'terminal-race-key'
        }
      )
    ).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      recommendedAction: 'REPLAN'
    });

    const statements = mock.queries.map(record => record.sql);
    expect(statements.some(sql => sql.startsWith('UPDATE productivity_tasks'))).toBe(false);
    expect(mock.eventInsertCount).toBe(0);
    expect(mock.receiptInsertCount).toBe(0);
    expect(statements).toContain('ROLLBACK');
  });

  test('reads the complete current-state snapshot in one repeatable-read transaction', async () => {
    const mock = new MockProductivityPool();
    mock.snapshotTasks = Array.from({ length: 101 }, (_, index) =>
      taskRow({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        title: `Task ${index + 1}`
      })
    );
    mock.snapshotProjects = [projectRow()];
    mock.snapshotNoteCount = 1;
    mock.snapshotReviews = [reviewRow()];
    const repository = new PostgresProductivityRepository(mock.pool);

    const snapshot = await repository.getCurrentStateSnapshot(SCOPE);

    expect(snapshot.tasks).toHaveLength(101);
    expect(snapshot.projects).toHaveLength(1);
    expect(snapshot.noteCount).toBe(1);
    expect(snapshot.reviews).toHaveLength(1);
    expect(mock.queries[0]?.sql).toBe(
      'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'
    );
    const reads = mock.queries.filter(record => record.sql.startsWith('SELECT'));
    expect(reads).toHaveLength(4);
    for (const read of reads) {
      expect(read.sql).not.toContain(' LIMIT ');
      expect(read.values).toEqual([SCOPE.principalId, SCOPE.workspaceId]);
    }
    expect(reads.some(read => read.sql.startsWith('SELECT COUNT(*) AS note_count'))).toBe(true);
    expect(reads.some(read => read.sql.startsWith('SELECT DISTINCT ON (kind)'))).toBe(true);
    expect(mock.queries.at(-1)?.sql).toBe('COMMIT');
    expect(mock.release).toHaveBeenCalledTimes(1);
  });

  test('preflights a stored receipt using the same semantic override as mutation', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);
    const semanticRequest = {
      task: 'Approve launch budget',
      expectedVersion: 1
    };
    const command = {
      ...createTaskCommand('reference-replay-key'),
      semanticRequest
    };

    const created = await repository.createTask(
      SCOPE,
      createTaskInput(),
      command
    );
    const replay = await repository.replayCommand(
      SCOPE,
      createTaskCommand('reference-replay-key'),
      semanticRequest
    );

    expect(replay).toEqual({
      value: created.value,
      replayed: true,
      changed: false
    });
    expect(mock.taskInsertCount).toBe(1);
    expect(mock.eventInsertCount).toBe(1);
    expect(mock.receiptInsertCount).toBe(1);

    await expect(repository.replayCommand(
      SCOPE,
      createTaskCommand('reference-replay-key'),
      { ...semanticRequest, task: 'Different task' }
    )).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
      recommendedAction: 'CHANGE_IDEMPOTENCY_KEY'
    });
  });

  test('normalizes uppercase UUID references before database matching', async () => {
    const mock = new MockProductivityPool();
    const repository = new PostgresProductivityRepository(mock.pool);

    await repository.findTasksByReference(SCOPE, TASK_ID.toUpperCase());
    await repository.findProjectsByReference(SCOPE, PROJECT_ID.toUpperCase());

    const referenceReads = mock.queries.filter(record =>
      record.sql.includes('id::text = $3')
    );
    expect(referenceReads).toHaveLength(2);
    expect(referenceReads[0]?.values.slice(2, 4)).toEqual([TASK_ID, TASK_ID]);
    expect(referenceReads[1]?.values.slice(2, 4)).toEqual([PROJECT_ID, PROJECT_ID]);
  });

  test('rejects task creation into a completed project inside the command transaction', async () => {
    const mock = new MockProductivityPool();
    mock.assignmentProjectStatus = 'completed';
    const repository = new PostgresProductivityRepository(mock.pool);

    await expect(repository.createTask(
      SCOPE,
      { ...createTaskInput(), projectId: PROJECT_ID },
      createTaskCommand('completed-project-create')
    )).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      recommendedAction: 'REPLAN'
    });

    expect(mock.taskInsertCount).toBe(0);
    expect(mock.eventInsertCount).toBe(0);
    expect(mock.receiptInsertCount).toBe(0);
    expect(mock.queries.some(record =>
      record.sql.includes('FROM productivity_projects')
      && record.sql.endsWith('FOR UPDATE')
    )).toBe(true);
    expect(mock.queries.some(record => record.sql === 'ROLLBACK')).toBe(true);
  });

  test('rejects task reassignment into an archived project inside the locked mutation', async () => {
    const mock = new MockProductivityPool();
    mock.currentTask = taskRow({ status: 'next', project_id: null });
    mock.assignmentProjectStatus = 'archived';
    const repository = new PostgresProductivityRepository(mock.pool);

    await expect(repository.transitionTask(
      SCOPE,
      TASK_ID,
      { status: 'next', projectId: PROJECT_ID },
      {
        action: 'task.transition',
        idempotencyKey: 'archived-project-reassign'
      }
    )).rejects.toMatchObject({
      code: 'INVALID_TRANSITION',
      recommendedAction: 'REPLAN'
    });

    expect(mock.queries.some(record =>
      record.sql.startsWith('UPDATE productivity_tasks')
    )).toBe(false);
    expect(mock.eventInsertCount).toBe(0);
    expect(mock.receiptInsertCount).toBe(0);
  });

  test('keeps completed_at null when an active project is archived directly', async () => {
    const mock = new MockProductivityPool();
    mock.currentProject = projectRow({
      status: 'active',
      completed_at: null,
      version: 1
    });
    mock.updatedProject = projectRow({
      status: 'archived',
      completed_at: null,
      version: 2
    });
    const repository = new PostgresProductivityRepository(mock.pool);

    const result = await repository.transitionProject(
      SCOPE,
      PROJECT_ID,
      { status: 'archived', expectedVersion: 1 },
      {
        action: 'project.transition',
        idempotencyKey: 'direct-archive'
      }
    );

    expect(result.value).toMatchObject({
      status: 'archived',
      completedAt: null,
      version: 2
    });
    const update = mock.queries.find(record =>
      record.sql.startsWith('UPDATE productivity_projects')
    );
    expect(update?.sql).toContain(
      "WHEN $4 = 'archived' THEN completed_at"
    );
  });
});
