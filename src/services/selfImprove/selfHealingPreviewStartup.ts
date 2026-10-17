/** Exact preview-only evidence for scheduler failure before initial readiness. */
import { createHash } from 'node:crypto';
import pg, { type ClientConfig } from 'pg';
import { shutdownChildAuthority, type ShutdownOwner, type ShutdownPgClient } from './selfHealingPreviewShutdown.js';

const TABLE = 'public.arcanos_self_heal_preview_startup_v1';
const OWNER_TABLE = 'public.arcanos_self_heal_preview_owner_v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const LOST_CONNECTIONS = new WeakSet<ShutdownPgClient>();
type Row = Record<string, unknown>;
interface ProbeOptions {
  createClient?: (config: ClientConfig) => ShutdownPgClient;
  authority?: typeof shutdownChildAuthority;
  fetchImpl?: typeof fetch;
}
export interface StartupFailureEvidence {
  readinessCommitted: boolean;
  scheduler: { installationAttempts: number; installations: number; installationFailures: number; callbacks: number };
  coordinator: { state: string; reasonCode: string | null; inFlight: boolean };
}
function fail(): never { throw new Error('SELF_HEAL_PREVIEW_STARTUP_EVIDENCE_FAILED'); }
function hash(owner: ShutdownOwner) { return createHash('sha256').update(JSON.stringify(owner)).digest('hex'); }
function validateOwner(owner: ShutdownOwner) {
  const issued = Date.parse(String(owner.issuedAt)); const expires = Date.parse(String(owner.expiresAt));
  if (owner.owner !== 'pbjustin' || owner.repository !== 'pbjustin/Arcanos' || !['worker-coordinator-v1', 'worker-inference-containment-v1'].includes(String(owner.profile))
    || (owner.profile === 'worker-inference-containment-v1' && !/^arc-pr1557-heavy-[a-z0-9][a-z0-9-]{0,13}$/u.test(String(owner.projectName)))
    || !/^[a-f0-9]{40}$/u.test(String(owner.sourceSha)) || !/^[a-f0-9]{64}$/u.test(String(owner.compiledSha256))
    || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(String(owner.runId)) || !Number.isFinite(issued) || !Number.isFinite(expires)
    || issued > Date.now() || expires <= Date.now() || expires - issued > 7_200_000 || expires <= issued) fail();
}
async function open(database: ClientConfig, owner: ShutdownOwner, options: ProbeOptions) {
  validateOwner(owner);
  const client = (options.createClient ?? (config => new pg.Client(config) as ShutdownPgClient))({ ...database,
    application_name: 'arcanos_self_heal_preview_startup_v1', connectionTimeoutMillis: 1000,
    query_timeout: 500, options: '-c statement_timeout=500 -c lock_timeout=100' });
  client.on?.('error', () => { LOST_CONNECTIONS.add(client); });
  try {
    await client.connect();
    if (LOST_CONNECTIONS.has(client)) fail();
    const identity = JSON.stringify(owner);
    const result = await client.query(`SELECT identity FROM ${OWNER_TABLE}
      WHERE singleton=TRUE AND identity=$1 AND clock_timestamp()<$2::timestamptz`, [identity, owner.expiresAt]);
    if (result.rows.length !== 1 || result.rows[0].identity !== identity) fail();
    return client;
  } catch { await client.end().catch(() => undefined); fail(); }
}
async function readBody(response: Response) {
  if (!response.body) fail();
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let size = 0;
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength; if (size > 4096) fail(); chunks.push(Buffer.from(next.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Row;
  } finally { await reader.cancel().catch(() => undefined); }
}
function validEvidence(value: StartupFailureEvidence) {
  return typeof value?.readinessCommitted === 'boolean'
    && ['installationAttempts', 'installations', 'installationFailures', 'callbacks'].every(key => {
      const count = value.scheduler?.[key as keyof StartupFailureEvidence['scheduler']];
      return Number.isSafeInteger(count) && count >= 0 && count <= 128;
    }) && ['RUNNING', 'DISABLED', 'BLOCKED', 'FAILED', 'UNKNOWN'].includes(value.coordinator?.state)
    && [null, 'scheduler_start_failed', 'shutdown_requested'].includes(value.coordinator?.reasonCode)
    && typeof value.coordinator?.inFlight === 'boolean';
}
function projectEvidence(value: StartupFailureEvidence) {
  return { readinessCommitted: value.readinessCommitted,
    scheduler: Object.fromEntries(['installationAttempts', 'installations', 'installationFailures', 'callbacks']
      .map(key => [key, value.scheduler[key as keyof StartupFailureEvidence['scheduler']]])),
    coordinator: { state: value.coordinator.state, reasonCode: value.coordinator.reasonCode, inFlight: value.coordinator.inFlight } };
}
function iso(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) fail(); return date.toISOString();
}

/** The parent health server already exists; sample its real readiness before bootstrap can commit. */
export async function beginSelfHealPreviewStartupProbe(env: NodeJS.ProcessEnv,
  binding: { processInstanceId: string; pid: number }, options: ProbeOptions = {}) {
  if (env.ARCANOS_PROCESS_KIND !== 'worker' || !['worker-coordinator-v1', 'worker-inference-containment-v1'].includes(env.ARCANOS_SELF_HEAL_PREVIEW_PROFILE ?? '')
    || env.ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE !== 'scheduler-failure' || !UUID.test(binding.processInstanceId)
    || !Number.isSafeInteger(binding.pid) || binding.pid < 2 || !UUID.test(env.RAILWAY_DEPLOYMENT_ID ?? '')) fail();
  const port = env.PORT ?? '8080';
  if (!/^\d{4,5}$/u.test(port) || Number(port) < 1024 || Number(port) > 65535 || ['8766', '8791'].includes(port)) fail();
  const { owner, database } = (options.authority ?? shutdownChildAuthority)(env);
  const client = await open(database, owner, options); let finished = false;
  try {
    const response = await (options.fetchImpl ?? fetch)(`http://127.0.0.1:${port}/readyz`,
      { redirect: 'error', signal: AbortSignal.timeout(1000) });
    const body = await readBody(response);
    if (response.status !== 503 || body.ready !== false || body.child !== 'starting') fail();
    if (LOST_CONNECTIONS.has(client)) fail();
    await client.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      run_id TEXT PRIMARY KEY, owner_sha256 TEXT NOT NULL, source_sha TEXT NOT NULL,
      process_instance_id TEXT NOT NULL, deployment_id TEXT NOT NULL, pid INTEGER NOT NULL,
      readiness_status_code INTEGER NOT NULL CHECK (readiness_status_code=503),
      readiness_ready BOOLEAN NOT NULL CHECK (readiness_ready=FALSE), readiness_child TEXT NOT NULL CHECK (readiness_child='starting'),
      observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ, evidence JSONB)`);
    const inserted = await client.query(`INSERT INTO ${TABLE}
      (run_id,owner_sha256,source_sha,process_instance_id,deployment_id,pid,readiness_status_code,readiness_ready,readiness_child)
      SELECT $1,$2,$3,$4,$5,$6,503,FALSE,'starting'
      WHERE EXISTS (SELECT 1 FROM ${OWNER_TABLE} WHERE singleton=TRUE AND identity=$7 AND clock_timestamp()<$8::timestamptz)
      RETURNING source_sha`, [owner.runId, hash(owner), owner.sourceSha, binding.processInstanceId,
      env.RAILWAY_DEPLOYMENT_ID, binding.pid, JSON.stringify(owner), owner.expiresAt]);
    if (inserted.rows.length !== 1) fail();
  } catch { await client.end().catch(() => undefined); fail(); }
  return { finish: async (evidence: StartupFailureEvidence) => {
    if (finished) fail(); finished = true;
    try {
      if (LOST_CONNECTIONS.has(client) || !validEvidence(evidence)) fail();
      const safe = projectEvidence(evidence);
      const result = await client.query(`UPDATE ${TABLE} SET finished_at=clock_timestamp(),evidence=$1::jsonb
        WHERE run_id=$2 AND owner_sha256=$3 AND source_sha=$4 AND process_instance_id=$5 AND deployment_id=$6
        AND finished_at IS NULL AND EXISTS (SELECT 1 FROM ${OWNER_TABLE}
          WHERE singleton=TRUE AND identity=$7 AND clock_timestamp()<$8::timestamptz) RETURNING source_sha`,
      [JSON.stringify(safe), owner.runId, hash(owner), owner.sourceSha, binding.processInstanceId,
        env.RAILWAY_DEPLOYMENT_ID, JSON.stringify(owner), owner.expiresAt]);
      if (result.rows.length !== 1) fail();
    } catch { fail(); }
    finally { await client.end().catch(() => undefined); }
  } };
}

/** Read only this run's immutable failed generation; never create or adopt a record. */
export async function readSelfHealPreviewStartupReceipt(database: ClientConfig, owner: ShutdownOwner, options: ProbeOptions = {}) {
  const client = await open(database, owner, options);
  try {
    if (LOST_CONNECTIONS.has(client)) fail();
    const result = await client.query(`SELECT source_sha,process_instance_id,deployment_id,pid,
      readiness_status_code,readiness_ready,readiness_child,observed_at,finished_at,evidence FROM ${TABLE}
      WHERE run_id=$1 AND owner_sha256=$2 AND source_sha=$3 AND EXISTS (SELECT 1 FROM ${OWNER_TABLE}
        WHERE singleton=TRUE AND identity=$4 AND clock_timestamp()<$5::timestamptz)`,
    [owner.runId, hash(owner), owner.sourceSha, JSON.stringify(owner), owner.expiresAt]);
    if (result.rows.length !== 1) fail(); const row = result.rows[0];
    const observedAt = iso(row.observed_at); const finishedAt = iso(row.finished_at);
    if (row.source_sha !== owner.sourceSha || !UUID.test(String(row.process_instance_id)) || !UUID.test(String(row.deployment_id))
      || !Number.isSafeInteger(row.pid) || Number(row.pid) < 2 || row.readiness_status_code !== 503
      || row.readiness_ready !== false || row.readiness_child !== 'starting' || !validEvidence(row.evidence as StartupFailureEvidence)
      || Date.parse(observedAt) < Date.parse(String(owner.issuedAt)) || Date.parse(observedAt) > Date.parse(finishedAt)
      || Date.parse(finishedAt) >= Date.parse(String(owner.expiresAt))) fail();
    return { evidence: 'independent_postgres_startup_readback', receipt: { scenario: 'A04', sourceSha: owner.sourceSha,
      compiledSha256: owner.compiledSha256, processInstanceId: row.process_instance_id, deploymentId: row.deployment_id, pid: row.pid,
      initialReadiness: { statusCode: 503, ready: false, child: 'starting', observedAt },
      finishedAt, outcome: projectEvidence(row.evidence as StartupFailureEvidence) } };
  } catch { fail(); }
  finally { await client.end().catch(() => undefined); }
}
