import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

const migrationScriptPath = join(process.cwd(), 'scripts', 'action-plan-execution-migration.mjs');
const connectionString = process.env.ACTION_PLAN_EXECUTION_MIGRATION_DATABASE_URL;

interface MigrationModule {
  applyMigrationWithClient: (client: unknown) => Promise<{
    ready: boolean;
    applied: boolean;
    equivalentRerun: boolean;
  }>;
  assertLocalEphemeralConnectionString: (value: string) => unknown;
  compensateMigrationWithClient: (client: unknown) => Promise<{ compensated: boolean }>;
  verifyActionPlanExecutionSchemaWithClient: (client: unknown) => Promise<{ ready: boolean }>;
}

function isConfirmedLocalEphemeralTarget(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, '')).toLowerCase();
    return (
      ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())
      && /^arcanos_phase2e_[a-z0-9_]+$/.test(databaseName)
    );
  } catch {
    return false;
  }
}

const hasConfirmedLocalEphemeralTarget = isConfirmedLocalEphemeralTarget(connectionString);

const describeLocalEphemeral = hasConfirmedLocalEphemeralTarget ? describe : describe.skip;

describeLocalEphemeral('Phase 2E migration against an explicit local ephemeral PostgreSQL database', () => {
  it('applies, verifies, reruns equivalently, preserves legacy rows, and compensates', async () => {
    const pg = await import('pg');
    const Client = pg.Client ?? pg.default.Client;
    const client = new Client({ connectionString });
    const migration = await import(pathToFileURL(migrationScriptPath).href) as MigrationModule;
    await client.connect();
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS "ActionPlan" (
        "id" TEXT PRIMARY KEY,
        "createdBy" TEXT NOT NULL,
        "origin" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'planned',
        "idempotencyKey" TEXT NOT NULL UNIQUE
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS "Action" (
        "id" TEXT PRIMARY KEY,
        "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT,
        "agentId" TEXT NOT NULL,
        "capability" TEXT NOT NULL,
        "params" JSONB NOT NULL
      )`);
      await client.query(`CREATE TABLE IF NOT EXISTS "ExecutionResult" (
        "id" TEXT PRIMARY KEY,
        "planId" TEXT NOT NULL REFERENCES "ActionPlan"("id") ON DELETE RESTRICT,
        "actionId" TEXT NOT NULL,
        "status" TEXT NOT NULL,
        UNIQUE ("planId", "actionId")
      )`);

      if (await client.query(`SELECT to_regclass('"ActionPlanExecutionSchemaMigration"') IS NOT NULL AS exists`).then(result => result.rows[0]?.exists)) {
        await migration.compensateMigrationWithClient(client);
      }

      await client.query(
        `INSERT INTO "ActionPlan" ("id", "createdBy", "origin", "status", "idempotencyKey")
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT ("id") DO NOTHING`,
        ['phase2e-legacy-plan', 'legacy-owner', 'local-test', 'approved', 'phase2e-legacy-key']
      );
      await client.query(
        `INSERT INTO "Action" ("id", "planId", "agentId", "capability", "params")
         VALUES ($1, $2, $3, $4, $5::jsonb)
         ON CONFLICT ("id") DO NOTHING`,
        ['phase2e-legacy-action', 'phase2e-legacy-plan', 'legacy-agent', 'terminal.run', '{}']
      );
      await client.query(
        `INSERT INTO "ExecutionResult" ("id", "planId", "actionId", "status")
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ("planId", "actionId") DO NOTHING`,
        ['phase2e-legacy-result', 'phase2e-legacy-plan', 'phase2e-legacy-action', 'success']
      );

      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: true,
        equivalentRerun: false
      });
      await expect(migration.applyMigrationWithClient(client)).resolves.toMatchObject({
        ready: true,
        applied: false,
        equivalentRerun: true
      });
      await expect(migration.verifyActionPlanExecutionSchemaWithClient(client)).resolves.toMatchObject({
        ready: true
      });

      const legacy = await client.query(
        `SELECT plan."executionRealm", plan."ownerPrincipalId", plan."executionProtocolVersion",
                plan."executionGeneration", result."status"
         FROM "ActionPlan" AS plan
         JOIN "ExecutionResult" AS result ON result."planId" = plan."id"
         WHERE plan."id" = $1`,
        ['phase2e-legacy-plan']
      );
      expect(legacy.rows[0]).toMatchObject({
        executionRealm: null,
        ownerPrincipalId: null,
        executionProtocolVersion: null,
        executionGeneration: null,
        status: 'success'
      });

      await expect(migration.compensateMigrationWithClient(client)).resolves.toMatchObject({
        compensated: true
      });
      const legacyAfterCompensation = await client.query(
        'SELECT "status" FROM "ExecutionResult" WHERE "id" = $1',
        ['phase2e-legacy-result']
      );
      expect(legacyAfterCompensation.rows[0]).toEqual({ status: 'success' });
    } finally {
      await client.end();
    }
  });
});
