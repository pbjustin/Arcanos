#!/usr/bin/env node
/** Bounded production catalog inventory. It never authorizes or performs a rollout. */
import { execFile } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { appendFileSync, closeSync, openSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import {
  readRailwayVariables,
  runBoundedRailwayCommand,
} from './railway-auto-deploy-observer.mjs';

export const PRODUCTION_INSPECTION_TARGET = Object.freeze({
  projectId: '7faf44e5-519c-4e73-8d7a-da9f389e6187',
  environmentId: 'fb583147-6c39-4343-9267-500f357d25ab',
  environmentName: 'production',
  databaseServiceId: '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  webServiceId: 'c4ade025-3f13-4fca-9309-5d0dd81396fe',
  workerServiceId: '1765befb-b805-4051-9af9-28634e986886',
  proxyHost: 'shortline.proxy.rlwy.net',
  proxyPort: '22628',
  databaseName: 'railway',
});
export const INSPECTION_RECEIPT_FILENAME = 'production-readonly-inspection.json';
const SHA = /^[0-9a-f]{40}$/u;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const TARGET = PRODUCTION_INSPECTION_TARGET;
const ROLE_IDS = { database: TARGET.databaseServiceId, web: TARGET.webServiceId, worker: TARGET.workerServiceId };
const COLUMN_NAMES = ['claim_generation', 'event_type', 'id', 'job_id', 'occurred_at', 'operation', 'stats_worker_id'];
const INDEX_NAMES = ['idx_job_events_worker_budget_claim_generation', 'idx_job_events_worker_budget_group_window'];
const MAX_RECEIPT_BYTES = 64 * 1024;

export const PRODUCTION_METADATA_QUERY = `query ProductionReadOnlyInspection {
  project(id: "${TARGET.projectId}") {
    id deletedAt services(first: 100) { pageInfo { hasNextPage } edges { node { id } } }
  }
  environment(id: "${TARGET.environmentId}") {
    id name projectId canAccess deletedAt
    serviceInstances(first: 100) { pageInfo { hasNextPage } edges { node {
      serviceId environmentId numReplicas
      activeDeployments { id status deploymentStopped meta instances { id status } }
    } } }
  }
}`;

export const CATALOG_QUERIES = Object.freeze({
  identity: `SELECT current_setting('server_version_num')::integer AS server_version_num,
    current_setting('transaction_read_only') AS transaction_read_only,
    current_database() AS database_name,
    to_regclass('public.job_events') IS NOT NULL AS job_events_exists`,
  columns: `SELECT attname, attnum, format_type(atttypid,atttypmod) AS data_type,
    attnotnull, attidentity, attgenerated,
    CASE WHEN attcollation=0 THEN NULL ELSE attcollation::regcollation::text END AS collation,
    atthasdef AS has_default
    FROM pg_catalog.pg_attribute
    WHERE attrelid=to_regclass('public.job_events')
      AND attname IN ('stats_worker_id','claim_generation','operation','event_type','id','job_id','occurred_at')
      AND NOT attisdropped ORDER BY attname`,
  constraints: `SELECT conname, contype, convalidated, conislocal, connoinherit,
    coninhcount, conparentid, conkey,
    COALESCE((to_jsonb(c)->>'conenforced')::boolean,true) AS enforced,
    pg_get_constraintdef(c.oid,false) AS definition,
    pg_get_expr(conbin,conrelid,false) AS expression
    FROM pg_catalog.pg_constraint c
    WHERE conrelid=to_regclass('public.job_events')
      AND conname='job_events_worker_budget_shape_check' ORDER BY conname`,
  indexes: `SELECT c.relname, i.indisvalid, i.indisready, i.indislive, i.indisunique,
    i.indisprimary, i.indisexclusion, i.indnkeyatts, i.indnatts, i.indkey::smallint[] AS indkey,
    am.amname, pg_get_indexdef(c.oid) AS definition,
    pg_get_expr(i.indpred,i.indrelid,true) AS predicate
    FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid
    JOIN pg_catalog.pg_am am ON am.oid=c.relam
    WHERE i.indrelid=to_regclass('public.job_events')
      AND c.relname IN ('idx_job_events_worker_budget_group_window','idx_job_events_worker_budget_claim_generation')
    ORDER BY c.relname`,
});

class InspectionError extends Error {}
function fail(code) { throw new InspectionError(code); }
function requireFact(condition, code) { if (!condition) fail(code); }
function serializeReceipt(receipt) { return `${JSON.stringify(receipt, null, 2)}\n`; }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value, limit = 8192, nullable = false) {
  if (nullable && value === null) return null;
  requireFact(typeof value === 'string' && Buffer.byteLength(value) <= limit && !/[\u0000-\u001f]/u.test(value), 'CATALOG_SHAPE_INVALID');
  return value;
}
function deadline(promise, milliseconds, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new InspectionError(code)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}
function nodes(connection) {
  requireFact(record(connection) && connection.pageInfo?.hasNextPage === false
    && Array.isArray(connection.edges) && connection.edges.length <= 100, 'METADATA_INCOMPLETE');
  return connection.edges.map(edge => {
    requireFact(record(edge?.node), 'METADATA_INVALID');
    return edge.node;
  });
}

export function sanitizeProductionMetadata(data) {
  requireFact(data?.project?.id === TARGET.projectId && data.project.deletedAt === null, 'PROJECT_IDENTITY_MISMATCH');
  const environment = data.environment;
  requireFact(environment?.id === TARGET.environmentId && environment.projectId === TARGET.projectId
    && environment.name === TARGET.environmentName && environment.canAccess === true && environment.deletedAt === null, 'ENVIRONMENT_IDENTITY_MISMATCH');
  const services = nodes(data.project.services);
  requireFact(services.every(s => typeof s.id === 'string' && UUID.test(s.id))
    && new Set(services.map(s => s.id)).size === services.length, 'METADATA_INVALID');
  const instances = nodes(environment.serviceInstances);
  requireFact(instances.every(i => typeof i.serviceId === 'string' && UUID.test(i.serviceId)
    && i.environmentId === TARGET.environmentId)
    && new Set(instances.map(i => i.serviceId)).size === instances.length, 'METADATA_INVALID');
  return Object.fromEntries(Object.entries(ROLE_IDS).map(([role, serviceId]) => {
    requireFact(services.filter(s => s.id === serviceId).length === 1, 'SERVICE_IDENTITY_MISMATCH');
    const instance = instances.find(i => i.serviceId === serviceId);
    requireFact(instance?.environmentId === TARGET.environmentId && (instance.numReplicas === null
      || (Number.isInteger(instance.numReplicas) && instance.numReplicas > 0 && instance.numReplicas <= 100))
      && Array.isArray(instance.activeDeployments) && instance.activeDeployments.length === 1, 'ACTIVE_DEPLOYMENT_INVALID');
    const deployment = instance.activeDeployments[0];
    requireFact(typeof deployment.id === 'string' && UUID.test(deployment.id)
      && deployment.status === 'SUCCESS' && deployment.deploymentStopped === false, 'ACTIVE_DEPLOYMENT_INVALID');
    requireFact(Array.isArray(deployment.instances) && deployment.instances.length > 0
      && deployment.instances.length <= 100 && deployment.instances.every(i => typeof i?.id === 'string'
        && UUID.test(i.id) && typeof i.status === 'string' && /^[A-Z_]{1,40}$/u.test(i.status))
      && new Set(deployment.instances.map(i => i.id)).size === deployment.instances.length, 'ACTIVE_DEPLOYMENT_INVALID');
    const observedInstances = deployment.instances.map(i => ({ id: i.id, status: i.status })).sort((a, b) => a.id.localeCompare(b.id));
    const runningInstances = observedInstances.filter(i => i.status === 'RUNNING').length;
    requireFact(runningInstances > 0, 'ACTIVE_DEPLOYMENT_INVALID');
    let meta = deployment.meta;
    if (typeof meta === 'string' && Buffer.byteLength(meta) <= 8192) {
      try { meta = JSON.parse(meta); } catch { meta = null; }
    }
    if (!record(meta)) meta = {};
    const cliClaim = typeof meta.cliMessage === 'string' ? /^GitHub auto deploy ([0-9a-f]{40})$/u.exec(meta.cliMessage)?.[1] : null;
    return [role, {
      serviceId, deploymentId: deployment.id, configuredReplicas: instance.numReplicas,
      runningInstanceCount: runningInstances, instances: observedInstances,
      commitHash: typeof meta.commitHash === 'string' && SHA.test(meta.commitHash) ? meta.commitHash : null,
      imageDigest: typeof meta.imageDigest === 'string' && /^sha256:[0-9a-f]{64}$/u.test(meta.imageDigest) ? meta.imageDigest : null,
      cliSourceClaim: cliClaim ?? null, sourceClaimVerified: false,
    }];
  }));
}

export function resolveProductionDatabaseUrl(variables) {
  requireFact(record(variables), 'VARIABLES_INVALID');
  for (const [name, value] of Object.entries({ RAILWAY_PROJECT_ID: TARGET.projectId,
    RAILWAY_ENVIRONMENT_ID: TARGET.environmentId, RAILWAY_SERVICE_ID: TARGET.databaseServiceId })) {
    requireFact(variables[name] === value, 'DATABASE_TARGET_MISMATCH');
  }
  requireFact(variables.RAILWAY_TCP_PROXY_DOMAIN === TARGET.proxyHost
    && String(variables.RAILWAY_TCP_PROXY_PORT) === TARGET.proxyPort
    && variables.PGDATABASE === TARGET.databaseName, 'DATABASE_TARGET_MISMATCH');
  let url;
  if (typeof variables.DATABASE_PUBLIC_URL === 'string' && variables.DATABASE_PUBLIC_URL.length > 0) {
    requireFact(variables.DATABASE_PUBLIC_URL === variables.DATABASE_PUBLIC_URL.trim(), 'DATABASE_URL_INVALID');
    try { url = new URL(variables.DATABASE_PUBLIC_URL); } catch { fail('DATABASE_URL_INVALID'); }
  } else {
    requireFact(typeof variables.PGUSER === 'string' && variables.PGUSER.length > 0
      && typeof variables.PGPASSWORD === 'string' && variables.PGPASSWORD.length > 0, 'DATABASE_CREDENTIALS_MISSING');
    url = new URL(`postgresql://${TARGET.proxyHost}:${TARGET.proxyPort}/${TARGET.databaseName}`);
    url.username = variables.PGUSER;
    url.password = variables.PGPASSWORD;
  }
  requireFact(['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === TARGET.proxyHost
    && url.port === TARGET.proxyPort && url.pathname === `/${TARGET.databaseName}`
    && url.username.length > 0 && url.password.length > 0 && !url.search && !url.hash, 'DATABASE_URL_INVALID');
  return url.toString();
}

/** Authenticate the public proxy with system trust or one operator-reviewed server certificate. */
export function createProductionInspectionTlsOptions(certificatePem) {
  if (certificatePem === undefined || certificatePem === '') return { rejectUnauthorized: true };
  requireFact(typeof certificatePem === 'string' && Buffer.byteLength(certificatePem) <= 16384,
    'DATABASE_CERTIFICATE_INVALID');
  const pem = certificatePem.trim();
  requireFact(/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----$/u.test(pem),
    'DATABASE_CERTIFICATE_INVALID');
  let pinned;
  try { pinned = new X509Certificate(pem); } catch { fail('DATABASE_CERTIFICATE_INVALID'); }
  return {
    // The reviewed peer certificate is the trust anchor, even when an omitted
    // issuer signed it. Validity and the exact peer fingerprint remain enforced.
    rejectUnauthorized: true, ca: pem, allowPartialTrustChain: true,
    checkServerIdentity(hostname, peer) {
      try {
        if (hostname === TARGET.proxyHost && new X509Certificate(peer.raw).fingerprint256 === pinned.fingerprint256) return undefined;
      } catch {}
      return new InspectionError('DATABASE_CERTIFICATE_MISMATCH');
    },
  };
}

function sanitizeCatalogRows(kind, rows) {
  requireFact(Array.isArray(rows) && rows.length <= (kind === 'columns' ? 7 : kind === 'indexes' ? 2 : 1), 'CATALOG_SHAPE_INVALID');
  const keys = kind === 'columns'
    ? { attname: 'name', attnum: 'number', data_type: 'string', attnotnull: 'boolean', attidentity: 'string', attgenerated: 'string', collation: 'nullable', has_default: 'boolean' }
    : kind === 'constraints'
      ? { conname: 'name', contype: 'string', convalidated: 'boolean', conislocal: 'boolean', connoinherit: 'boolean', coninhcount: 'number', conparentid: 'number', conkey: 'array', enforced: 'boolean', definition: 'string', expression: 'string' }
      : { relname: 'name', indisvalid: 'boolean', indisready: 'boolean', indislive: 'boolean', indisunique: 'boolean', indisprimary: 'boolean', indisexclusion: 'boolean', indnkeyatts: 'number', indnatts: 'number', indkey: 'array', amname: 'string', definition: 'string', predicate: 'nullable' };
  const names = kind === 'columns' ? COLUMN_NAMES : kind === 'indexes' ? INDEX_NAMES : ['job_events_worker_budget_shape_check'];
  const result = rows.map(row => Object.fromEntries(Object.entries(keys).map(([key, type]) => {
    const value = row?.[key];
    if (type === 'boolean') requireFact(typeof value === 'boolean', 'CATALOG_SHAPE_INVALID');
    else if (type === 'number') requireFact(Number.isSafeInteger(value) && value >= 0, 'CATALOG_SHAPE_INVALID');
    else if (type === 'array') requireFact(Array.isArray(value) && value.length <= 16 && value.every(v => Number.isInteger(v) && v >= (key === 'indkey' ? 0 : 1)), 'CATALOG_SHAPE_INVALID');
    else { text(value, ['definition', 'predicate', 'expression'].includes(key) ? 8192 : 255, type === 'nullable'); }
    if (type === 'name') requireFact(names.includes(value), 'CATALOG_SHAPE_INVALID');
    return [key, value];
  })));
  const nameKey = kind === 'columns' ? 'attname' : kind === 'constraints' ? 'conname' : 'relname';
  requireFact(new Set(result.map(row => row[nameKey])).size === result.length, 'CATALOG_SHAPE_INVALID');
  return result;
}

async function fetchProductionMetadata(token, fetchImpl) {
  const controller = new AbortController();
  const expiresAt = Date.now() + 5000;
  let reader;
  let complete = false;
  try {
    const response = await deadline(fetchImpl('https://backboard.railway.com/graphql/v2', {
      method: 'POST', headers: { 'content-type': 'application/json', 'Project-Access-Token': token },
      body: JSON.stringify({ query: PRODUCTION_METADATA_QUERY }), signal: controller.signal, redirect: 'error',
    }), 5000, 'METADATA_TIMEOUT');
    requireFact(response.ok, 'PROVIDER_READ_FAILED');
    requireFact(typeof response.body?.getReader === 'function', 'PROVIDER_READ_FAILED');
    reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const item = await deadline(reader.read(), Math.max(1, expiresAt - Date.now()), 'METADATA_TIMEOUT');
      if (item.done) { complete = true; break; }
      const buffer = Buffer.from(item.value);
      totalBytes += buffer.length;
      requireFact(totalBytes <= 2 * 1024 * 1024, 'METADATA_TOO_LARGE');
      chunks.push(buffer);
    }
    const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireFact(!payload.errors && record(payload.data), 'PROVIDER_READ_FAILED');
    return payload.data;
  } finally {
    controller.abort();
    if (reader && !complete) { try { await deadline(reader.cancel(), 50, 'METADATA_TIMEOUT'); } catch {} }
  }
}

export async function collectProductionReadOnlyInspection(options = {}) {
  const sourceSha = options.sourceSha ?? process.env.DEPLOY_REF;
  const token = options.token ?? process.env.RAILWAY_TOKEN;
  const receipt = {
    schema: 'arcanos-production-readonly-inventory/v1', status: 'BLOCKED', target: TARGET,
    inspectionSourceSha: typeof sourceSha === 'string' && SHA.test(sourceSha) ? sourceSha : null,
    observedAt: new Date((options.now ?? Date.now)()).toISOString(),
    contractVerdict: 'NOT_EVALUATED', runningSourceVerdict: 'UNVERIFIED',
    historicalQuietWindow: 'UNVERIFIED', nativeTriggers: 'NOT_INSPECTED',
    deploymentPerformed: false, migrationPerformed: false, holdCleared: false,
  };
  const timeoutMs = options.timeoutMs ?? 5000;
  const startedAt = Date.now();
  let clientErrorOccurred = false;
  let rejectClientError;
  const clientFailure = new Promise((_, reject) => { rejectClientError = reject; });
  clientFailure.catch(() => {});
  const bounded = (operation, code) => deadline(Promise.race([operation, clientFailure]),
    Math.min(timeoutMs, Math.max(1, 90000 - (Date.now() - startedAt))), code);
  let client;
  let transactionStarted = false;
  let stage = 'input';
  try {
    requireFact(receipt.inspectionSourceSha !== null, 'INSPECTION_SOURCE_INVALID');
    requireFact(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 5000, 'INSPECTION_BOUNDS_INVALID');
    requireFact(typeof token === 'string' && token.length > 0 && token === token.trim(), 'PROJECT_TOKEN_MISSING');
    const ssl = createProductionInspectionTlsOptions(options.databaseCertificatePem ?? process.env.RAILWAY_PRODUCTION_DATABASE_CERTIFICATE);
    const readMetadata = options.readMetadata ?? (() => fetchProductionMetadata(token, options.fetch ?? fetch));
    stage = 'metadata_before';
    receipt.deployments = sanitizeProductionMetadata(await bounded(readMetadata(), 'METADATA_TIMEOUT'));
    stage = 'variables';
    const raw = await deadline((options.readVariables ?? (() => readRailwayVariables({ serviceId: TARGET.databaseServiceId,
      environmentName: TARGET.environmentName }, { runCommand: options.runCommand ?? runBoundedRailwayCommand })))(), 30000, 'VARIABLE_READ_TIMEOUT');
    const databaseUrl = resolveProductionDatabaseUrl(typeof raw === 'string' ? JSON.parse(raw) : raw);
    const databasePassword = decodeURIComponent(new URL(databaseUrl).password);
    const Client = options.Client ?? (await import('pg')).Client;
    stage = 'connecting';
    client = new Client({ connectionString: databaseUrl, ssl,
      connectionTimeoutMillis: 5000, query_timeout: 5000, application_name: 'arcanos_production_readonly_inspection_v1',
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000 -c idle_in_transaction_session_timeout=10000' });
    client.on('error', () => {
      clientErrorOccurred = true;
      rejectClientError(new InspectionError('DATABASE_CLIENT_ERROR'));
    });
    await bounded(client.connect(), 'DATABASE_TIMEOUT');
    stage = 'begin';
    transactionStarted = true;
    await bounded(client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'), 'DATABASE_TIMEOUT');
    await bounded(client.query('SET LOCAL search_path = pg_catalog, public'), 'DATABASE_TIMEOUT');
    stage = 'identity';
    const identity = (await bounded(client.query(CATALOG_QUERIES.identity), 'DATABASE_TIMEOUT')).rows?.[0];
    requireFact(identity?.transaction_read_only === 'on', 'READ_ONLY_NOT_ENFORCED');
    requireFact(identity.database_name === TARGET.databaseName && Number.isInteger(identity.server_version_num)
      && identity.server_version_num >= 170000 && identity.server_version_num < 190000
      && typeof identity.job_events_exists === 'boolean', 'DATABASE_IDENTITY_MISMATCH');
    receipt.database = { serverVersionNum: identity.server_version_num, databaseName: TARGET.databaseName,
      readOnly: true, jobEventsExists: identity.job_events_exists };
    for (const kind of ['columns', 'constraints', 'indexes']) {
      stage = kind;
      const rows = sanitizeCatalogRows(kind, (await bounded(client.query(CATALOG_QUERIES[kind]), 'DATABASE_TIMEOUT')).rows);
      requireFact(rows.every(row => Object.values(row).every(value => typeof value !== 'string'
        || (!value.includes(token) && !value.includes(databasePassword)))), 'CATALOG_CREDENTIAL_LEAK');
      receipt[kind] = rows;
    }
    stage = 'metadata_after';
    const after = sanitizeProductionMetadata(await bounded(readMetadata(), 'METADATA_TIMEOUT'));
    requireFact(JSON.stringify(receipt.deployments) === JSON.stringify(after), 'ACTIVE_DEPLOYMENT_DRIFT');
    requireFact(!clientErrorOccurred, 'DATABASE_CLIENT_ERROR');
    receipt.metadataStable = true;
    receipt.status = 'COLLECTION_COMPLETE';
  } catch (error) {
    receipt.failedStage = stage;
    receipt.errorCode = error instanceof InspectionError ? error.message : 'INSPECTION_READ_FAILED';
  } finally {
    if (client) {
      let cleanupFailed = false;
      if (transactionStarted) {
        try { await deadline(client.query('ROLLBACK'), timeoutMs, 'CLEANUP_TIMEOUT'); } catch { cleanupFailed = true; }
      }
      try { await deadline(client.end(), timeoutMs, 'CLEANUP_TIMEOUT'); }
      catch { cleanupFailed = true; client.connection?.stream?.destroy?.(); }
      receipt.connectionClosed = !cleanupFailed;
      if (cleanupFailed) { receipt.status = 'BLOCKED'; receipt.failedStage = 'cleanup'; receipt.errorCode = 'DATABASE_CLEANUP_FAILED'; }
      else if (clientErrorOccurred) {
        receipt.status = 'BLOCKED'; receipt.failedStage ??= 'cleanup'; receipt.errorCode = 'DATABASE_CLIENT_ERROR';
      }
    }
  }
  if (Buffer.byteLength(serializeReceipt(receipt)) > MAX_RECEIPT_BYTES) {
    return {
      schema: receipt.schema, status: 'BLOCKED', target: TARGET,
      inspectionSourceSha: receipt.inspectionSourceSha, observedAt: receipt.observedAt,
      contractVerdict: receipt.contractVerdict, runningSourceVerdict: receipt.runningSourceVerdict,
      historicalQuietWindow: receipt.historicalQuietWindow, nativeTriggers: receipt.nativeTriggers,
      failedStage: 'receipt', errorCode: 'RECEIPT_TOO_LARGE', connectionClosed: receipt.connectionClosed,
      deploymentPerformed: false, migrationPerformed: false, holdCleared: false,
    };
  }
  return receipt;
}

export function writeProductionInspectionReceipt(receipt, directory, fileSystem = { openSync, writeFileSync, closeSync }) {
  requireFact(typeof directory === 'string' && isAbsolute(directory), 'RECEIPT_DIRECTORY_INVALID');
  const serialized = serializeReceipt(receipt);
  requireFact(Buffer.byteLength(serialized) <= MAX_RECEIPT_BYTES, 'RECEIPT_TOO_LARGE');
  const output = resolve(directory, INSPECTION_RECEIPT_FILENAME);
  const descriptor = fileSystem.openSync(output, 'wx', 0o600);
  try { fileSystem.writeFileSync(descriptor, serialized); } finally { fileSystem.closeSync(descriptor); }
  return output;
}

async function main() {
  requireFact(process.argv.length === 2 && process.env.GITHUB_ACTIONS === 'true'
    && process.env.GITHUB_REPOSITORY === 'pbjustin/Arcanos'
    && process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    && process.env.GITHUB_REF === 'refs/heads/main'
    && process.env.GITHUB_WORKFLOW_REF === 'pbjustin/Arcanos/.github/workflows/railway-auto-deploy.yml@refs/heads/main'
    && SHA.test(process.env.DEPLOY_REF ?? '')
    && process.env.DEPLOY_REF === process.env.GITHUB_WORKFLOW_SHA
    && process.env.DEPLOY_REF === process.env.GITHUB_SHA, 'TRUSTED_MAIN_REQUIRED');
  const checkout = await promisify(execFile)('git', ['rev-parse', 'HEAD'], {
    env: { PATH: process.env.PATH }, timeout: 5000, maxBuffer: 1024,
  });
  requireFact(checkout.stdout.trim() === process.env.DEPLOY_REF, 'TRUSTED_CHECKOUT_MISMATCH');
  const receipt = await collectProductionReadOnlyInspection();
  writeProductionInspectionReceipt(receipt, process.env.RUNNER_TEMP);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'inspection_receipt_written=true\n');
  console.log(JSON.stringify({ status: receipt.status, receipt: INSPECTION_RECEIPT_FILENAME }));
  if (receipt.status !== 'COLLECTION_COMPLETE') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error('PRODUCTION_READONLY_INSPECTION_BLOCKED'); process.exitCode = 1; });
}
