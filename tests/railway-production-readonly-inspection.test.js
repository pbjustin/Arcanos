import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CATALOG_QUERIES,
  INSPECTION_RECEIPT_FILENAME,
  PRODUCTION_INSPECTION_TARGET as TARGET,
  PRODUCTION_METADATA_QUERY,
  collectProductionReadOnlyInspection,
  resolveProductionDatabaseUrl,
  sanitizeProductionMetadata,
  writeProductionInspectionReceipt,
} from '../scripts/railway-production-readonly-inspection.mjs';

const SOURCE = 'a'.repeat(40);
const SECRET = 'test-only-database-password';
const TOKEN = 'test-only-project-token';
const fixtureId = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const clone = value => JSON.parse(JSON.stringify(value));
function connection(nodes) { return { pageInfo: { hasNextPage: false }, edges: nodes.map(node => ({ node })) }; }
function metadata() {
  const serviceIds = [TARGET.databaseServiceId, TARGET.webServiceId, TARGET.workerServiceId];
  return {
    project: { id: TARGET.projectId, deletedAt: null, services: connection(serviceIds.map(id => ({ id }))) },
    environment: { id: TARGET.environmentId, projectId: TARGET.projectId, name: 'production', canAccess: true, deletedAt: null,
      serviceInstances: connection(serviceIds.map((serviceId, i) => ({ serviceId, environmentId: TARGET.environmentId,
        numReplicas: null, activeDeployments: [{ id: fixtureId(i + 1), status: 'SUCCESS', deploymentStopped: false,
          instances: [{ id: fixtureId(i + 10), status: 'RUNNING' }],
          meta: { cliMessage: `GitHub auto deploy ${SOURCE}`, commitHash: SOURCE,
            imageDigest: `sha256:${'b'.repeat(64)}`, ignoredSecret: SECRET } }] }))) },
  };
}
function variables() {
  return { RAILWAY_PROJECT_ID: TARGET.projectId, RAILWAY_ENVIRONMENT_ID: TARGET.environmentId,
    RAILWAY_SERVICE_ID: TARGET.databaseServiceId, RAILWAY_TCP_PROXY_DOMAIN: TARGET.proxyHost,
    RAILWAY_TCP_PROXY_PORT: TARGET.proxyPort, PGDATABASE: TARGET.databaseName,
    PGUSER: 'test-only-user', PGPASSWORD: SECRET, ignoredSecret: SECRET };
}
function catalog() {
  return {
    identity: [{ server_version_num: 170006, transaction_read_only: 'on', database_name: 'railway', job_events_exists: true }],
    columns: ['id', 'job_id', 'event_type', 'occurred_at', 'stats_worker_id', 'claim_generation', 'operation'].map((attname, i) => ({
      attname, attnum: i + 1, data_type: 'text', attnotnull: false, attidentity: '', attgenerated: '', collation: null, has_default: false,
    })),
    constraints: [{ conname: 'job_events_worker_budget_shape_check', contype: 'c', convalidated: true,
      conislocal: true, connoinherit: false, coninhcount: 0, conparentid: 0, conkey: [3, 5, 6, 7], enforced: true,
      definition: 'CHECK (claim_generation >= 0)', expression: '(claim_generation >= 0)' }],
    indexes: ['idx_job_events_worker_budget_claim_generation', 'idx_job_events_worker_budget_group_window'].map(relname => ({
      relname, indisvalid: true, indisready: true, indislive: true, indisunique: false, indisprimary: false,
      indisexclusion: false, indnkeyatts: 4, indnatts: 4, indkey: [5, 6, 2, 4], amname: 'btree',
      definition: `CREATE INDEX ${relname} ON public.job_events USING btree (stats_worker_id, claim_generation, job_id, occurred_at)`,
      predicate: "(event_type = 'worker_budget')",
    })),
  };
}
function fixture(overrides = {}) {
  const rows = catalog();
  const state = { queries: [], connect: 0, end: 0, destroy: 0 };
  class Client extends EventEmitter {
    constructor(config) {
      super(); state.client = this; state.config = config;
      this.connection = { stream: { destroy: () => { state.destroy += 1; } } };
    }
    async connect() { state.connect += 1; if (overrides.connect) return overrides.connect(this); }
    async query(sql) {
      state.queries.push(sql);
      if (overrides.query) await overrides.query(sql, this);
      const kind = Object.keys(CATALOG_QUERIES).find(key => CATALOG_QUERIES[key] === sql);
      return { rows: kind ? rows[kind] : [] };
    }
    async end() { state.end += 1; if (overrides.end) return overrides.end(this); }
  }
  const options = { sourceSha: SOURCE, token: TOKEN, Client, readMetadata: jest.fn(async () => metadata()),
    readVariables: jest.fn(async () => variables()), ...overrides.options };
  return { state, rows, options, collect: () => collectProductionReadOnlyInspection(options) };
}

describe('production read-only inspection', () => {
  it('collects a PG17 inventory with platform-default replicas and separates every release verdict', async () => {
    const f = fixture();
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'COLLECTION_COMPLETE', inspectionSourceSha: SOURCE,
      database: { serverVersionNum: 170006, readOnly: true }, contractVerdict: 'NOT_EVALUATED',
      runningSourceVerdict: 'UNVERIFIED', historicalQuietWindow: 'UNVERIFIED', nativeTriggers: 'NOT_INSPECTED',
      deploymentPerformed: false, migrationPerformed: false, holdCleared: false, connectionClosed: true, metadataStable: true });
    expect(receipt.deployments.database).toMatchObject({ configuredReplicas: null, runningInstanceCount: 1,
      cliSourceClaim: SOURCE, sourceClaimVerified: false });
    expect(receipt.columns.map(row => row.attname)).toEqual(['id', 'job_id', 'event_type', 'occurred_at', 'stats_worker_id', 'claim_generation', 'operation']);
    expect(receipt.constraints[0]).toMatchObject({ conkey: [3, 5, 6, 7], expression: '(claim_generation >= 0)', enforced: true, conparentid: 0 });
    expect(receipt.indexes[0].indkey).toEqual([5, 6, 2, 4]);
    expect(f.state.queries).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'SET LOCAL search_path = pg_catalog, public',
      ...Object.values(CATALOG_QUERIES), 'ROLLBACK']);
    expect(Object.values(CATALOG_QUERIES).every(sql => /^SELECT\b/u.test(sql))).toBe(true);
    expect(f.state.config).toMatchObject({ connectionTimeoutMillis: 5000, query_timeout: 5000,
      ssl: { rejectUnauthorized: true },
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000' });
    expect(f.state.end).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it('reads variables through only the existing bounded exact-target CLI helper', async () => {
    const runCommand = jest.fn(async () => JSON.stringify(variables()));
    const f = fixture({ options: { readVariables: undefined, runCommand } });
    expect((await f.collect()).status).toBe('COLLECTION_COMPLETE');
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand.mock.calls[0][0]).toEqual(['variable', 'list', '--service', TARGET.databaseServiceId, '--environment', 'production', '--json']);
    expect(runCommand.mock.calls[0][1]).toEqual({ timeoutMs: 30000, maxBufferBytes: 1048576 });
  });

  it('also inventories PG18 without converting collection into compatibility approval', async () => {
    const f = fixture(); f.rows.identity[0].server_version_num = 180003;
    expect(await f.collect()).toMatchObject({ status: 'COLLECTION_COMPLETE', contractVerdict: 'NOT_EVALUATED' });
  });

  it.each(['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_TCP_PROXY_DOMAIN', 'RAILWAY_TCP_PROXY_PORT', 'PGDATABASE'])
    ('rejects a mismatched %s before connecting', async name => {
      const v = variables(); v[name] = 'test-only-wrong-target';
      const f = fixture({ options: { readVariables: async () => v } });
      expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode: 'DATABASE_TARGET_MISMATCH' });
      expect(f.state.connect).toBe(0);
    });

  it('encodes credential characters in memory and accepts only the exact public proxy URL', () => {
    const v = variables(); v.PGUSER = 'test:user@one'; v.PGPASSWORD = 'test:/?@two';
    const url = new URL(resolveProductionDatabaseUrl(v));
    expect(decodeURIComponent(url.username)).toBe(v.PGUSER);
    expect(decodeURIComponent(url.password)).toBe(v.PGPASSWORD);
    v.DATABASE_PUBLIC_URL = url.toString();
    expect(resolveProductionDatabaseUrl(v)).toBe(url.toString());
    v.DATABASE_PUBLIC_URL = 'postgresql://test:fixture@other.example:22628/railway';
    expect(() => resolveProductionDatabaseUrl(v)).toThrow('DATABASE_URL_INVALID');
  });

  it('blocks missing database credentials without exposing variable values', async () => {
    const v = variables(); delete v.PGPASSWORD;
    const f = fixture({ options: { readVariables: async () => v } });
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode: 'DATABASE_CREDENTIALS_MISSING' });
    expect(f.state.connect).toBe(0);
  });

  it.each([
    ['read-only disabled', identity => { identity.transaction_read_only = 'off'; }, 'READ_ONLY_NOT_ENFORCED'],
    ['unsupported major', identity => { identity.server_version_num = 160004; }, 'DATABASE_IDENTITY_MISMATCH'],
    ['wrong actual database', identity => { identity.database_name = 'other'; }, 'DATABASE_IDENTITY_MISMATCH'],
  ])('blocks %s and rolls back', async (_, change, errorCode) => {
    const f = fixture(); change(f.rows.identity[0]);
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode, connectionClosed: true });
    expect(f.state.queries.at(-1)).toBe('ROLLBACK');
    expect(f.state.end).toBe(1);
  });

  it('retains incomplete catalog inventory without asserting a valid contract', async () => {
    const f = fixture(); f.rows.constraints = []; f.rows.indexes = []; f.rows.columns = [];
    expect(await f.collect()).toMatchObject({ status: 'COLLECTION_COMPLETE', contractVerdict: 'NOT_EVALUATED', constraints: [], indexes: [] });
  });

  it('redacts raw query failures and forged inspectionCode properties while cleaning up', async () => {
    const f = fixture({ query: sql => {
      if (sql === CATALOG_QUERIES.constraints) throw Object.assign(new Error(`${SECRET} ${TOKEN}`), { inspectionCode: SECRET });
    } });
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', failedStage: 'constraints', errorCode: 'INSPECTION_READ_FAILED', connectionClosed: true });
    expect(f.state.queries.at(-1)).toBe('ROLLBACK');
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.stringify(receipt)).not.toContain(TOKEN);
  });

  it('handles idle driver errors during the final metadata read without an unhandled raw error', async () => {
    const f = fixture(); let calls = 0;
    f.options.readMetadata = async () => {
      if (++calls === 2) f.state.client.emit('error', new Error(SECRET));
      return metadata();
    };
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', errorCode: 'DATABASE_CLIENT_ERROR', connectionClosed: true });
    expect(f.state.queries.at(-1)).toBe('ROLLBACK');
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('bounds a hanging read and still attempts rollback and connection close', async () => {
    const f = fixture({ options: { timeoutMs: 15 }, query: sql => sql === CATALOG_QUERIES.columns ? new Promise(() => {}) : undefined });
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode: 'DATABASE_TIMEOUT', connectionClosed: true });
    expect(f.state.queries.at(-1)).toBe('ROLLBACK');
    expect(f.state.end).toBe(1);
  });

  it.each(['rollback', 'end'])('blocks unsuccessful %s cleanup and never prints the error', async phase => {
    const f = fixture({ query: sql => { if (phase === 'rollback' && sql === 'ROLLBACK') throw new Error(SECRET); },
      end: () => { if (phase === 'end') throw new Error(SECRET); } });
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', failedStage: 'cleanup', errorCode: 'DATABASE_CLEANUP_FAILED', connectionClosed: false });
    expect(f.state.end).toBe(1);
    expect(f.state.destroy).toBe(phase === 'end' ? 1 : 0);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('rejects deployment drift across independently fetched metadata snapshots', async () => {
    const f = fixture(); const before = metadata(); const after = clone(before);
    after.environment.serviceInstances.edges[1].node.activeDeployments[0].id = fixtureId(99);
    f.options.readMetadata = jest.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', failedStage: 'metadata_after', errorCode: 'ACTIVE_DEPLOYMENT_DRIFT', connectionClosed: true });
  });

  it.each([
    ['partial pagination', data => { data.project.services.pageInfo.hasNextPage = true; }],
    ['wrong environment', data => { data.environment.id = fixtureId(90); }],
    ['duplicate instance', data => { const d = data.environment.serviceInstances.edges[0].node.activeDeployments[0]; d.instances.push(d.instances[0]); }],
    ['no running instance', data => { data.environment.serviceInstances.edges[0].node.activeDeployments[0].instances[0].status = 'STOPPED'; }],
    ['missing target service', data => { data.project.services.edges.pop(); }],
  ])('blocks %s metadata before reading credentials', async (_, change) => {
    const data = metadata(); change(data);
    const f = fixture({ options: { readMetadata: async () => data } });
    expect((await f.collect()).status).toBe('BLOCKED');
    expect(f.options.readVariables).not.toHaveBeenCalled();
    expect(f.state.connect).toBe(0);
  });

  it('accepts bounded JSON metadata but treats cli messages only as exact unverified claims', () => {
    const data = metadata(); const deployment = data.environment.serviceInstances.edges[0].node.activeDeployments[0];
    deployment.meta = JSON.stringify({ cliMessage: `GitHub auto deploy ${SOURCE}`, ignoredSecret: SECRET });
    expect(sanitizeProductionMetadata(data).database).toMatchObject({ cliSourceClaim: SOURCE, sourceClaimVerified: false });
    deployment.meta = { cliMessage: `GitHub auto deploy ${SOURCE} ${SECRET}`, imageDigest: SECRET, commitHash: SECRET };
    expect(sanitizeProductionMetadata(data).database).toMatchObject({ cliSourceClaim: null, commitHash: null, imageDigest: null });
  });

  it('uses the supported endpoint/project-token header and a fixed metadata-only query at both reads', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify({ data: metadata() })));
    const f = fixture({ options: { readMetadata: undefined, fetch: fetchImpl } });
    expect((await f.collect()).status).toBe('COLLECTION_COMPLETE');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    for (const [endpoint, request] of fetchImpl.mock.calls) {
      expect(endpoint).toBe('https://backboard.railway.com/graphql/v2');
      expect(request).toMatchObject({ method: 'POST', redirect: 'error', headers: { 'Project-Access-Token': TOKEN } });
      expect(JSON.parse(request.body)).toEqual({ query: PRODUCTION_METADATA_QUERY });
      expect(request.signal.aborted).toBe(true);
    }
    expect(PRODUCTION_METADATA_QUERY).not.toMatch(/mutation|decryptVariables|config\s*\(/u);
    expect(PRODUCTION_METADATA_QUERY).toContain('instances { id status }');
  });

  it('cancels streamed metadata immediately when the response exceeds its byte cap', async () => {
    const cancel = jest.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel });
    const f = fixture({ options: { readMetadata: undefined, fetch: async () => new Response(body) } });
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode: 'METADATA_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(f.options.readVariables).not.toHaveBeenCalled();
  });

  it('never exposes GraphQL error payloads or HTTP errors in a receipt', async () => {
    const f = fixture({ options: { readMetadata: undefined, fetch: async () => new Response(JSON.stringify({ errors: [{ message: SECRET }] })) } });
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', errorCode: 'PROVIDER_READ_FAILED' });
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('rejects oversized catalog definitions rather than retaining arbitrary provider text', async () => {
    const f = fixture(); f.rows.constraints[0].expression = 'x'.repeat(8193);
    expect(await f.collect()).toMatchObject({ status: 'BLOCKED', errorCode: 'CATALOG_SHAPE_INVALID', connectionClosed: true });
  });

  it.each([SECRET, TOKEN])('withholds catalog definitions containing a known credential', async credential => {
    const f = fixture(); f.rows.constraints[0].definition = `CHECK (operation <> '${credential}')`;
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', failedStage: 'constraints', errorCode: 'CATALOG_CREDENTIAL_LEAK', connectionClosed: true });
    expect(receipt).not.toHaveProperty('constraints');
    expect(JSON.stringify(receipt)).not.toContain(credential);
    expect(f.state.queries.at(-1)).toBe('ROLLBACK');
  });

  it('blocks malformed certificate configuration before reading database credentials', async () => {
    const f = fixture({ options: { databaseCertificatePem: SECRET } });
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', errorCode: 'DATABASE_CERTIFICATE_INVALID' });
    expect(f.options.readVariables).not.toHaveBeenCalled();
    expect(f.state.connect).toBe(0);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });

  it('retains a sanitized receipt when database certificate authentication fails', async () => {
    const f = fixture({ connect: () => { throw Object.assign(new Error(SECRET), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }); } });
    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', failedStage: 'connecting', errorCode: 'INSPECTION_READ_FAILED', connectionClosed: true });
    expect(f.state.config.ssl.rejectUnauthorized).toBe(true);
    expect(f.state.queries).toEqual([]);
    expect(f.state.end).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
  });
});

describe('sanitized receipt retention', () => {
  const directories = [];
  afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
  const directory = () => { const value = mkdtempSync(join(tmpdir(), 'arcanos-readonly-inspection-test-')); directories.push(value); return value; };

  it('writes only the fixed private receipt and refuses overwrites', async () => {
    const receipt = await fixture().collect(); const dir = directory();
    const fileSystem = { openSync: jest.fn(openSync), writeFileSync, closeSync: jest.fn(closeSync) };
    const path = writeProductionInspectionReceipt(receipt, dir, fileSystem);
    expect(path).toBe(join(dir, INSPECTION_RECEIPT_FILENAME));
    expect(fileSystem.openSync).toHaveBeenCalledWith(path, 'wx', 0o600);
    expect(fileSystem.closeSync).toHaveBeenCalledWith(fileSystem.openSync.mock.results[0].value);
    // NTFS does not expose POSIX owner/group mode bits. Keep the restrictive
    // request assertion above and compare the OS representation with an
    // independently created 0600 reference; this is not an NTFS ACL proof.
    const reference = join(directory(), 'restrictive-mode-reference');
    writeFileSync(reference, '', { mode: 0o600, flag: 'wx' });
    expect(statSync(path).mode & 0o777).toBe(statSync(reference).mode & 0o777);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(receipt);
    expect(() => writeProductionInspectionReceipt(receipt, dir)).toThrow();
  });

  it.each(['', '.', 'relative/path', 'C:relative'])('rejects a nonabsolute receipt directory %j', value => {
    const fileSystem = { openSync: jest.fn(), writeFileSync: jest.fn(), closeSync: jest.fn() };
    expect(() => writeProductionInspectionReceipt({}, value, fileSystem)).toThrow('RECEIPT_DIRECTORY_INVALID');
    expect(fileSystem.openSync).not.toHaveBeenCalled();
  });

  it('closes the exclusively opened descriptor when retaining a receipt fails', () => {
    const fileSystem = { openSync: jest.fn(() => 71), writeFileSync: jest.fn(() => { throw new Error('fixture-write-failed'); }),
      closeSync: jest.fn() };
    expect(() => writeProductionInspectionReceipt({}, directory(), fileSystem)).toThrow('fixture-write-failed');
    expect(fileSystem.closeSync).toHaveBeenCalledWith(71);
  });

  it.each([5000, 8192])('retains a blocked receipt when bounded inventory with %s-byte definitions exceeds artifact size', async length => {
    const data = metadata();
    for (const [role, edge] of data.environment.serviceInstances.edges.entries()) {
      edge.node.activeDeployments[0].instances = Array.from({ length: 100 }, (_, i) => ({
        id: fixtureId(1000 + role * 100 + i), status: 'RUNNING',
      }));
    }
    const f = fixture({ options: { readMetadata: async () => data } });
    for (const row of f.rows.constraints) {
      row.definition = 'x'.repeat(length); row.expression = 'x'.repeat(length);
    }
    for (const row of f.rows.indexes) {
      row.definition = 'x'.repeat(length); row.predicate = 'x'.repeat(length);
    }
    const inventory = { ...await fixture().collect(), deployments: sanitizeProductionMetadata(data),
      constraints: f.rows.constraints, indexes: f.rows.indexes };
    expect(Buffer.byteLength(`${JSON.stringify(inventory, null, 2)}\n`)).toBeGreaterThan(65536);
    if (length === 5000) expect(Buffer.byteLength(JSON.stringify(inventory))).toBeLessThanOrEqual(65536);
    else expect(Buffer.byteLength(JSON.stringify(inventory))).toBeGreaterThan(65536);

    const receipt = await f.collect();
    expect(receipt).toMatchObject({ status: 'BLOCKED', failedStage: 'receipt', errorCode: 'RECEIPT_TOO_LARGE',
      inspectionSourceSha: SOURCE, target: TARGET, connectionClosed: true,
      contractVerdict: 'NOT_EVALUATED', runningSourceVerdict: 'UNVERIFIED', historicalQuietWindow: 'UNVERIFIED',
      deploymentPerformed: false, migrationPerformed: false, holdCleared: false });
    expect(receipt).not.toHaveProperty('deployments');
    expect(receipt).not.toHaveProperty('constraints');
    expect(f.state.end).toBe(1);
    expect(JSON.stringify(receipt)).not.toContain(SECRET);
    expect(JSON.parse(readFileSync(writeProductionInspectionReceipt(receipt, directory()), 'utf8'))).toEqual(receipt);
  });

  it('refuses symlinked output and an oversized receipt', () => {
    const dir = directory(); const target = directory(); const other = join(target, 'test-only-protected'); writeFileSync(other, 'preserve');
    // Directory junctions exercise a real link without Windows symlink elevation.
    symlinkSync(target, join(dir, INSPECTION_RECEIPT_FILENAME), 'junction');
    expect(() => writeProductionInspectionReceipt({ status: 'BLOCKED' }, dir)).toThrow();
    expect(readFileSync(other, 'utf8')).toBe('preserve');
    expect(() => writeProductionInspectionReceipt({ definition: 'x'.repeat(65536) }, directory())).toThrow('RECEIPT_TOO_LARGE');
  });
});
