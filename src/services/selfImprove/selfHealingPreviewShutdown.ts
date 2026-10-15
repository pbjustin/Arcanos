/** Fixed, owner-bound PostgreSQL receipts for the two preview shutdown cases. */
import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg, { type ClientConfig } from 'pg';

export const PREVIEW_SHUTDOWN_TABLE = 'public.arcanos_self_heal_preview_shutdown_v1';
export const PREVIEW_SHUTDOWN_BARRIER_MS = 5_000;
export type PreviewShutdownScenario = 'A06' | 'E06';
const PHASES = new Set(['prepared', 'evaluation_held', 'shutdown_seen', 'barrier_released', 'barrier_expired',
  'coordinator_drained', 'redis_stop_begin', 'redis_stopped', 'independent_held_probe', 'independent_barrier_releasing',
  'independent_redis_closed', 'independent_process_exited']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const QUERY_TIMEOUT_MS = 250;
type Row = Record<string, unknown>;
export interface ShutdownPgClient {
  connect(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Row[] }>;
  end(): Promise<void>;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
export type ShutdownOwner = Record<string, unknown>;
function fail(): never { throw new Error('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED'); }
function digest(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }
function validData(data: unknown): data is Row {
  return Boolean(data && typeof data === 'object' && !Array.isArray(data)
    && Buffer.byteLength(JSON.stringify(data)) <= 1_024
    && Object.keys(data).every(key => ['redisClientId', 'inFlight', 'redisConnected', 'signalSeen', 'elapsedMs',
      'processAlive', 'redisClientPresent', 'providerHealthy', 'drainAbsent', 'redisServerRunId', 'readinessWithheld'].includes(key))
    && Object.entries(data).every(([key, value]) => key === 'elapsedMs'
      ? typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10_000
      : key === 'redisClientId' ? typeof value === 'string' && /^[1-9]\d{0,18}$/u.test(value)
      : key === 'redisServerRunId' ? typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value)
      : typeof value === 'boolean'));
}

/** The child has already passed the exact normal-launcher profile/artifact gate. */
export function shutdownChildAuthority(env: NodeJS.ProcessEnv) {
  const artifact = JSON.parse(readFileSync(new URL('../../../scripts/self-heal-preview-artifact.json', import.meta.url), 'utf8')) as Row;
  const pem = readFileSync('/app/config/self-heal-preview-database-ca.pem', 'utf8');
  if (artifact.version !== 1 || artifact.sourceSha !== env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA
    || !/^[a-f0-9]{64}$/u.test(String(artifact.compiledSha256))) fail();
  const owner: ShutdownOwner = {
    version: 1, owner: 'pbjustin', repository: 'pbjustin/Arcanos', profile: 'worker-coordinator-v1',
    projectId: env.RAILWAY_PROJECT_ID, projectName: env.RAILWAY_PROJECT_NAME,
    environmentId: env.RAILWAY_ENVIRONMENT_ID, environmentName: env.RAILWAY_ENVIRONMENT_NAME,
    webServiceId: env.ARCANOS_SELF_HEAL_PREVIEW_WEB_SERVICE_ID, workerServiceId: env.ARCANOS_SELF_HEAL_PREVIEW_WORKER_SERVICE_ID,
    postgresServiceId: env.ARCANOS_BACKSTAGE_HEAVY_POSTGRES_SERVICE_ID, redisServiceId: env.ARCANOS_BACKSTAGE_HEAVY_REDIS_SERVICE_ID,
    runId: env.ARCANOS_SELF_HEAL_PREVIEW_RUN_ID, sourceSha: env.ARCANOS_BACKSTAGE_HEAVY_PROOF_SOURCE_SHA,
    issuedAt: env.ARCANOS_SELF_HEAL_PREVIEW_ISSUED_AT, expiresAt: env.ARCANOS_SELF_HEAL_PREVIEW_EXPIRES_AT,
    databaseCertificateSha256: digest(new X509Certificate(pem).raw), compiledSha256: artifact.compiledSha256,
  };
  const url = new URL(env.DATABASE_URL ?? '');
  if (url.hostname !== 'postgres.railway.internal' || url.port !== '5432'
    || url.searchParams.size !== 2 || url.searchParams.get('sslmode') !== 'verify-full'
    || url.searchParams.get('sslrootcert') !== '/app/config/self-heal-preview-database-ca.pem') fail();
  url.search = '';
  return { owner, database: { connectionString: url.toString(), ssl: { rejectUnauthorized: true, ca: pem } } };
}

export interface ShutdownBinding {
  scenario: PreviewShutdownScenario; processInstanceId: string; deploymentId: string; pid: number; redisClientId: string;
}

export class PreviewShutdownJournal {
  private scenario: PreviewShutdownScenario | null = null;
  private binding: ShutdownBinding | null = null;
  private ended = false;
  private connectionLost = false;
  private barrierOwned = false;
  private readonly ownerHash: string;
  private constructor(private readonly client: ShutdownPgClient, private readonly owner: ShutdownOwner) {
    this.ownerHash = digest(JSON.stringify(owner));
  }
  static async open(database: ClientConfig, owner: ShutdownOwner,
    createPgClient: (config: ClientConfig) => ShutdownPgClient = config => new pg.Client(config) as ShutdownPgClient) {
    if (!/^[a-f0-9]{40}$/u.test(String(owner.sourceSha)) || !/^[a-f0-9]{64}$/u.test(String(owner.compiledSha256))
      || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(String(owner.runId))
      || owner.profile !== 'worker-coordinator-v1' || owner.repository !== 'pbjustin/Arcanos'
      || !Number.isFinite(Date.parse(String(owner.expiresAt))) || Date.parse(String(owner.expiresAt)) <= Date.now()) fail();
    const client = createPgClient({ ...database, application_name: 'arcanos_self_heal_preview_shutdown_v1',
      connectionTimeoutMillis: 1_000, query_timeout: QUERY_TIMEOUT_MS, options: '-c statement_timeout=250 -c lock_timeout=100' });
    const journal = new PreviewShutdownJournal(client, owner);
    client.on?.('error', () => { journal.connectionLost = true; });
    try {
      await client.connect();
      const receipt = await client.query('SELECT identity FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton = TRUE');
      if (receipt.rows.length !== 1 || receipt.rows[0].identity !== JSON.stringify(owner)) fail();
      return journal;
    } catch { await client.end().catch(() => undefined); fail(); }
  }
  private assertLease() {
    if (this.ended || this.connectionLost || Date.parse(String(this.owner.expiresAt)) <= Date.now()) fail();
  }
  async prepare(binding: ShutdownBinding) {
    this.assertLease();
    if (!['A06', 'E06'].includes(binding.scenario) || !UUID.test(binding.processInstanceId)
      || !/^[a-f0-9-]{36}$/u.test(binding.deploymentId) || !Number.isSafeInteger(binding.pid) || binding.pid < 2
      || !/^[1-9]\d{0,18}$/u.test(binding.redisClientId)) fail();
    await this.client.query(`CREATE TABLE IF NOT EXISTS ${PREVIEW_SHUTDOWN_TABLE} (
      run_id TEXT NOT NULL, scenario TEXT NOT NULL CHECK (scenario IN ('A06','E06')), owner_sha256 TEXT NOT NULL,
      source_sha TEXT NOT NULL, process_instance_id TEXT NOT NULL, deployment_id TEXT NOT NULL,
      pid INTEGER NOT NULL, redis_client_id TEXT NOT NULL, events JSONB NOT NULL DEFAULT '[]'::jsonb,
      PRIMARY KEY (run_id, scenario))`);
    const inserted = await this.client.query(`INSERT INTO ${PREVIEW_SHUTDOWN_TABLE}
      (run_id,scenario,owner_sha256,source_sha,process_instance_id,deployment_id,pid,redis_client_id)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8 WHERE clock_timestamp()<$9::timestamptz
      AND EXISTS (SELECT 1 FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton=TRUE AND identity=$10)
      RETURNING process_instance_id`, [this.owner.runId, binding.scenario, this.ownerHash,
      this.owner.sourceSha, binding.processInstanceId, binding.deploymentId, binding.pid, binding.redisClientId,
      this.owner.expiresAt, JSON.stringify(this.owner)]);
    if (inserted.rows.length !== 1) fail();
    this.scenario = binding.scenario; this.binding = binding;
    await this.append('prepared', { redisClientId: binding.redisClientId });
  }
  async append(phase: string, data: Row = {}) {
    this.assertLease();
    if (!this.binding || !PHASES.has(phase) || !validData(data)) fail();
    const result = await this.client.query(`UPDATE ${PREVIEW_SHUTDOWN_TABLE}
      SET events = events || jsonb_build_array(jsonb_build_object('phase',$1::text,'at',clock_timestamp(),'data',$2::jsonb))
      WHERE run_id=$3 AND scenario=$4 AND owner_sha256=$5 AND source_sha=$6 AND process_instance_id=$7
      AND clock_timestamp()<$8::timestamptz
      AND EXISTS (SELECT 1 FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton=TRUE AND identity=$9)
      AND jsonb_array_length(events)<12 AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(events) e WHERE e->>'phase'=$1)
      RETURNING process_instance_id`, [phase, JSON.stringify(data), this.owner.runId, this.scenario, this.ownerHash,
      this.owner.sourceSha, this.binding.processInstanceId, this.owner.expiresAt, JSON.stringify(this.owner)]);
    if (result.rows.length !== 1) fail();
  }
  async read(scenario: PreviewShutdownScenario) {
    this.assertLease();
    if (!['A06', 'E06'].includes(scenario)) fail();
    const result = await this.client.query(`SELECT scenario,source_sha,process_instance_id,deployment_id,pid,redis_client_id,events
      FROM ${PREVIEW_SHUTDOWN_TABLE} WHERE run_id=$1 AND scenario=$2 AND owner_sha256=$3 AND source_sha=$4
      AND clock_timestamp()<$5::timestamptz
      AND EXISTS (SELECT 1 FROM public.arcanos_self_heal_preview_owner_v1 WHERE singleton=TRUE AND identity=$6)`,
    [this.owner.runId, scenario, this.ownerHash, this.owner.sourceSha, this.owner.expiresAt, JSON.stringify(this.owner)]);
    if (result.rows.length !== 1) fail();
    const row = result.rows[0];
    if (!UUID.test(String(row.process_instance_id)) || !Array.isArray(row.events) || row.events.length > 12
      || row.scenario !== scenario || row.source_sha !== this.owner.sourceSha
      || !/^[a-f0-9-]{36}$/u.test(String(row.deployment_id)) || !/^[1-9]\d{0,18}$/u.test(String(row.redis_client_id))
      || !Number.isSafeInteger(row.pid) || Number(row.pid) < 2
      || row.events.some((event: Row) => !event || typeof event !== 'object'
        || Object.keys(event).sort().join(',') !== 'at,data,phase' || !PHASES.has(String(event.phase))
        || !Number.isFinite(Date.parse(String(event.at))) || !validData(event.data))
      || new Set(row.events.map((event: Row) => event.phase)).size !== row.events.length) fail();
    this.scenario = scenario;
    this.binding = { scenario, processInstanceId: String(row.process_instance_id), deploymentId: String(row.deployment_id),
      pid: Number(row.pid), redisClientId: String(row.redis_client_id) };
    return { scenario, sourceSha: String(row.source_sha), processInstanceId: this.binding.processInstanceId,
      deploymentId: this.binding.deploymentId, pid: this.binding.pid, redisClientId: this.binding.redisClientId,
      events: row.events.map((event: Row) => ({ phase: String(event.phase), at: String(event.at), data: event.data as Row })) };
  }
  async holdBarrier() {
    this.assertLease();
    const result = await this.client.query('SELECT pg_try_advisory_lock(1544, 5) AS acquired');
    if (result.rows[0]?.acquired !== true) fail();
    this.barrierOwned = true;
  }
  async releaseBarrier() {
    if (!this.barrierOwned) return;
    const result = await this.client.query('SELECT pg_advisory_unlock(1544, 5) AS released');
    this.barrierOwned = false;
    if (result.rows[0]?.released !== true) fail();
  }
  async barrierAvailable() {
    this.assertLease();
    const result = await this.client.query('SELECT pg_try_advisory_lock(1544, 5) AS acquired');
    if (result.rows[0]?.acquired !== true) return false;
    await this.client.query('SELECT pg_advisory_unlock(1544, 5) AS released');
    return true;
  }
  async waitForShutdownRelease(signal?: AbortSignal) {
    const started = Date.now();
    if (await this.barrierAvailable()) fail();
    await this.append('evaluation_held', { inFlight: true });
    let signalSeen = false;
    // Reserve the worst four 250ms round trips in an iteration (new abort,
    // try-lock, unlock and release receipt), plus one final expiry receipt.
    // A late abort must not add another round trip after the five-second limit.
    const deadline = started + PREVIEW_SHUTDOWN_BARRIER_MS;
    const remainingQueryReserveMs = 5 * QUERY_TIMEOUT_MS;
    while (deadline - Date.now() > remainingQueryReserveMs) {
      if (signal?.aborted && !signalSeen) { signalSeen = true; await this.append('shutdown_seen', { signalSeen: true }); }
      if (await this.barrierAvailable()) {
        await this.append('barrier_released', { signalSeen, elapsedMs: Date.now() - started });
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    await this.append('barrier_expired', { signalSeen, elapsedMs: Date.now() - started });
  }
  async close() {
    if (this.ended) return;
    try { await this.releaseBarrier(); }
    finally { this.ended = true; await this.client.end(); }
  }
}
