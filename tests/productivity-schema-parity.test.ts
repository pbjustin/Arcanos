import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool } from 'pg';

import { PostgresProductivityRepository } from '../src/core/db/repositories/productivityRepository.js';
import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';
import {
  PRODUCTIVITY_PROJECT_STATUSES,
  PRODUCTIVITY_REVIEW_KINDS,
  PRODUCTIVITY_TASK_STATUSES,
  ProductivityError
} from '../src/services/productivity/productivityTypes.js';

const migrationPath = join(
  process.cwd(),
  'migrations',
  '20260724_productivity_core.sql'
);
const migrationSql = readFileSync(migrationPath, 'utf8');

const PRODUCTIVITY_TABLES = [
  'productivity_projects',
  'productivity_tasks',
  'productivity_notes',
  'productivity_reviews',
  'productivity_events',
  'productivity_command_receipts'
] as const;

const PRODUCTIVITY_INDEXES = [
  'idx_productivity_projects_scope_status_updated',
  'idx_productivity_tasks_scope_status_due',
  'idx_productivity_tasks_scope_project_status',
  'idx_productivity_notes_scope_updated',
  'idx_productivity_reviews_scope_type_date',
  'idx_productivity_events_scope_occurred',
  'idx_productivity_events_unpublished',
  'idx_productivity_command_receipts_scope_expires'
] as const;

function normalizeSql(statement: string): string {
  return statement
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/;$/u, '');
}

function migrationProductivityStatements(): string[] {
  return migrationSql
    .replace(/^--.*$/gmu, '')
    .split(';')
    .map(normalizeSql)
    .filter(statement =>
      statement.startsWith('CREATE ')
      && statement.includes('productivity_')
    )
    .sort();
}

function startupProductivityStatements(): string[] {
  return TABLE_DEFINITIONS
    .map(normalizeSql)
    .filter(statement =>
      statement.startsWith('CREATE ')
      && statement.includes('productivity_')
    )
    .sort();
}

function normalizeQuery(sql: string): string {
  return sql.replace(/\s+/gu, ' ').trim();
}

class ProductivityRepositoryHarness {
  tasks: Array<Record<string, unknown>> = [];
  events: Array<Record<string, unknown>> = [];
  receipts = new Map<string, { request_fingerprint: string; result: unknown }>();
  failEventInsert = false;
  private transactionSnapshot: {
    taskCount: number;
    eventCount: number;
    receipts: Map<string, { request_fingerprint: string; result: unknown }>;
  } | null = null;

  readonly pool = {
    connect: async () => ({
      query: async (sql: string, values: unknown[] = []) => this.query(sql, values),
      release: () => undefined
    }),
    query: async (sql: string, values: unknown[] = []) => this.query(sql, values)
  } as unknown as Pool;

  private result(rows: unknown[] = []) {
    return {
      rows,
      rowCount: rows.length
    };
  }

  private receiptKey(values: unknown[]): string {
    return [values[0], values[1], values[2], values[3]].join(':');
  }

  async query(rawSql: string, values: unknown[] = []) {
    const sql = normalizeQuery(rawSql);
    if (sql === 'BEGIN') {
      this.transactionSnapshot = {
        taskCount: this.tasks.length,
        eventCount: this.events.length,
        receipts: new Map(this.receipts)
      };
      return this.result();
    }
    if (sql === 'COMMIT') {
      this.transactionSnapshot = null;
      return this.result();
    }
    if (sql === 'ROLLBACK') {
      if (this.transactionSnapshot) {
        this.tasks.splice(this.transactionSnapshot.taskCount);
        this.events.splice(this.transactionSnapshot.eventCount);
        this.receipts = new Map(this.transactionSnapshot.receipts);
      }
      this.transactionSnapshot = null;
      return this.result();
    }
    if (sql.startsWith('SELECT pg_advisory_xact_lock(')) {
      return this.result([{}]);
    }
    if (sql.startsWith('SELECT request_fingerprint, result FROM productivity_command_receipts')) {
      const receipt = this.receipts.get(this.receiptKey(values));
      return this.result(receipt ? [receipt] : []);
    }
    if (sql.startsWith('INSERT INTO productivity_tasks')) {
      const row = {
        id: `10000000-0000-4000-8000-${String(this.tasks.length + 1).padStart(12, '0')}`,
        project_id: values[2] ?? null,
        title: values[3],
        details: values[4] ?? null,
        status: values[5],
        priority: values[6],
        due_at: values[7] ?? null,
        defer_until: values[8] ?? null,
        completed_at: null,
        version: '1',
        created_at: '2026-07-24T12:00:00.000Z',
        updated_at: '2026-07-24T12:00:00.000Z'
      };
      this.tasks.push(row);
      return this.result([row]);
    }
    if (sql.startsWith('INSERT INTO productivity_events')) {
      if (this.failEventInsert) {
        throw new Error('SENTINEL_PRODUCTIVITY_EVENT_FAILURE');
      }
      this.events.push({
        ownerPrincipalId: values[0],
        workspaceId: values[1],
        aggregateType: values[2],
        aggregateId: values[3],
        eventType: values[5],
        payload: JSON.parse(String(values[6]))
      });
      return this.result();
    }
    if (
      sql.startsWith('WITH expired_receipts AS')
      && sql.includes('INSERT INTO productivity_command_receipts')
    ) {
      this.receipts.set(
        this.receiptKey(values),
        {
          request_fingerprint: String(values[4]),
          result: JSON.parse(String(values[5]))
        }
      );
      return this.result();
    }
    if (sql.includes('FROM productivity_tasks') && sql.startsWith('SELECT')) {
      const scopedRows = this.tasks.filter(row =>
        row.owner_principal_id === values[0]
        && row.workspace_id === values[1]
      );
      return this.result(scopedRows);
    }
    throw new Error(`Unhandled productivity repository query: ${sql}`);
  }
}

describe('productivity schema parity', () => {
  it('keeps the authoritative migration and startup bootstrap byte-semantically aligned', () => {
    expect(startupProductivityStatements()).toEqual(migrationProductivityStatements());
  });

  it('defines the complete six-table model and all reviewed indexes', () => {
    const startupSql = TABLE_DEFINITIONS.join('\n');

    for (const table of PRODUCTIVITY_TABLES) {
      expect(migrationSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      expect(startupSql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    for (const index of PRODUCTIVITY_INDEXES) {
      expect(migrationSql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
      expect(startupSql).toContain(`CREATE INDEX IF NOT EXISTS ${index}`);
    }
  });

  it('keeps database lifecycle constraints aligned with TypeScript-owned statuses', () => {
    for (const status of PRODUCTIVITY_TASK_STATUSES) {
      expect(migrationSql).toContain(`'${status}'`);
    }
    for (const status of PRODUCTIVITY_PROJECT_STATUSES) {
      expect(migrationSql).toContain(`'${status}'`);
    }
    for (const kind of PRODUCTIVITY_REVIEW_KINDS) {
      expect(migrationSql).toContain(`'${kind}'`);
    }
  });

  it('enforces tenant-safe relationships, optimistic versions, and idempotent commands', () => {
    expect(migrationSql).toContain(
      'UNIQUE (owner_principal_id, workspace_id, id)'
    );
    expect(migrationSql.match(
      /FOREIGN KEY \(owner_principal_id, workspace_id, project_id\)/gu
    )).toHaveLength(2);
    expect(migrationSql.match(/CHECK \(version >= 1\)/gu)).toHaveLength(3);
    expect(migrationSql).toContain(
      'UNIQUE (owner_principal_id, workspace_id, action, idempotency_key_hash)'
    );
    expect(migrationSql).toContain(
      "CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$')"
    );
    expect(migrationSql).toContain(
      "expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days')"
    );
    expect(migrationSql).toContain('CHECK (expires_at > created_at)');
    expect(migrationSql).toContain('event_sequence BIGSERIAL NOT NULL');
    expect(migrationSql).toContain('UNIQUE (event_sequence)');
    expect(migrationSql).toContain('WHERE published_at IS NULL');
    expect(migrationSql).toContain(
      'ON productivity_events(event_sequence)'
    );
  });

  it('keeps the forward migration additive and non-destructive', () => {
    expect(migrationSql).not.toMatch(
      /(?:^|;)\s*(?:DROP\b|TRUNCATE\b|DELETE\s+FROM\b)/imu
    );
    expect(migrationSql).not.toMatch(/\bALTER\s+TABLE\b[\s\S]*?\bDROP\b/iu);
  });
});

describe('productivity repository command guarantees', () => {
  const scope = {
    principalId: 'principal:test',
    workspaceId: 'workspace:test',
    requestId: 'request:test',
    traceId: 'trace:test'
  };
  const command = {
    action: 'task.create' as const,
    idempotencyKey: 'task-create-1',
    requestId: 'request:test',
    traceId: 'trace:test'
  };

  it('stores one mutation, event, and hashed receipt and replays the stored result', async () => {
    const harness = new ProductivityRepositoryHarness();
    const repository = new PostgresProductivityRepository(harness.pool);
    const input = {
      title: 'Prepare release notes',
      status: 'next' as const,
      priority: 2
    };

    const created = await repository.createTask(scope, input, command);
    const replayed = await repository.createTask(scope, input, command);

    expect(created).toMatchObject({ replayed: false, changed: true });
    expect(replayed).toEqual({
      value: created.value,
      replayed: true,
      changed: false
    });
    expect(harness.tasks).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.receipts.size).toBe(1);
    const storedReceiptKey = Array.from(harness.receipts.keys())[0];
    expect(storedReceiptKey).not.toContain(command.idempotencyKey);
    expect(storedReceiptKey).toMatch(/[0-9a-f]{64}$/u);
  });

  it('rejects changed semantics under a reused key without a second effect', async () => {
    const harness = new ProductivityRepositoryHarness();
    const repository = new PostgresProductivityRepository(harness.pool);
    await repository.createTask(
      scope,
      { title: 'Prepare release notes', status: 'next', priority: 2 },
      command
    );

    await expect(repository.createTask(
      scope,
      { title: 'Publish release notes', status: 'next', priority: 2 },
      command
    )).rejects.toMatchObject<ProductivityError>({
      code: 'IDEMPOTENCY_CONFLICT'
    });
    expect(harness.tasks).toHaveLength(1);
    expect(harness.events).toHaveLength(1);
    expect(harness.receipts.size).toBe(1);
  });

  it('rolls the canonical mutation back when its event cannot be written', async () => {
    const harness = new ProductivityRepositoryHarness();
    harness.failEventInsert = true;
    const repository = new PostgresProductivityRepository(harness.pool);

    await expect(repository.createTask(
      scope,
      { title: 'Prepare release notes', status: 'next', priority: 2 },
      command
    )).rejects.toMatchObject<ProductivityError>({
      code: 'INTERNAL_ERROR'
    });
    expect(harness.tasks).toHaveLength(0);
    expect(harness.events).toHaveLength(0);
    expect(harness.receipts.size).toBe(0);
  });
});
