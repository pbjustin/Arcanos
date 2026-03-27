import { describe, expect, it } from '@jest/globals';
import { TABLE_DEFINITIONS } from '../src/core/db/schema.js';

describe('database schema bootstrap', () => {
  it('creates the Prisma action-plan tables during startup initialization', () => {
    const schemaSql = TABLE_DEFINITIONS.join('\n');

    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS "Agent"');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS "ActionPlan"');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS "Action"');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS "ExecutionResult"');
    expect(schemaSql).toContain('CREATE TABLE IF NOT EXISTS "ClearScore"');
  });

  it('creates indexes needed by action-plan queries and execution history lookups', () => {
    const schemaSql = TABLE_DEFINITIONS.join('\n');

    expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_action_plan_status_created_at');
    expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_action_plan_sort_order');
    expect(schemaSql).toContain('CREATE INDEX IF NOT EXISTS idx_execution_result_plan_created_at');
  });
});
