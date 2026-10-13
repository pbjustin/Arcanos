#!/usr/bin/env node
/**
 * Exercises the unchanged production entry point in a network-disabled container.
 * All provider data, GitHub context, credentials, certificates and SQL are fixtures.
 * No collector dependency is replaced, and no production service is contacted.
 */
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync, chmodSync, chownSync, copyFileSync, existsSync, lstatSync,
  mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import {
  CATALOG_QUERIES, INSPECTION_RECEIPT_FILENAME, PRODUCTION_INSPECTION_TARGET as TARGET,
  PRODUCTION_METADATA_QUERY, sanitizeProductionMetadata,
} from '../../../scripts/railway-production-readonly-inspection.mjs';
import { requiredFixtureCases } from './cases.mjs';
import { generateExpiredCertificate } from './expired-certificate.mjs';

const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const root = resolve(fixtureDirectory, '../../..');
const sourceSha = process.env.FIXTURE_SOURCE_SHA;
const postgresMajor = Number(process.env.FIXTURE_POSTGRES_MAJOR);
const postgresBin = `/usr/lib/postgresql/${postgresMajor}/bin`;
const proofDirectory = '/proof';
const applicationName = 'arcanos_production_readonly_inspection_v1';
const token = `test-only-project-token-${randomBytes(12).toString('hex')}`;
const password = `test-only-database-password-${randomBytes(12).toString('hex')}`;
const sqlLiteral = value => `'${value.replaceAll("'", "''")}'`;
const sha256 = value => createHash('sha256').update(value).digest('hex');
const normalizeSql = value => value.replace(/\s+/gu, ' ').trim();
const fixtureId = n => `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
const delay = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds));
const proof = {
  schema: 'arcanos-production-inspection-e2e/v1', status: 'FAIL', sourceSha, postgresMajor,
  relevantWorktreeDirty: process.env.FIXTURE_SOURCE_DIRTY === 'true', nodeVersion: process.version,
  execution: 'unchanged collector CLI; isolated synthetic provider and GitHub context',
  syntheticGithubAuthority: true,
  cases: [],
};
let temporaryDirectory;
let admin;
let metadataServer;
let currentCase;
let clusterStarted = false;
const sockets = new Set();

function check(condition, code) {
  if (!condition) throw new Error(code);
}

function command(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      encoding: 'utf8', timeout: 15000, maxBuffer: 256 * 1024,
      env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, ...options,
    });
  } catch (error) {
    // Never retain command arguments or captured output: they can include SQL.
    const name = basename(executable).toUpperCase().replace(/[^A-Z0-9_]/gu, '_');
    const status = Number.isInteger(error.status) ? error.status : 'FAILED';
    throw new Error(`FIXTURE_COMMAND_${name}_${status}`);
  }
}

function postgresCommand(executable, args) {
  return command('runuser', ['-u', 'postgres', '--', join(postgresBin, executable), ...args]);
}

function generateCertificate(name, hostname, { issuer, expired = false } = {}) {
  proof.setupStage = `certificate-${name}`;
  const base = join(temporaryDirectory, name);
  const key = `${base}.key`;
  const cert = `${base}.crt`;
  const csr = `${base}.csr`;
  const extensions = `${base}.extensions`;
  if (expired) {
    const pair = generateExpiredCertificate();
    writeFileSync(key, pair.key, { mode: 0o600 });
    writeFileSync(cert, pair.cert, { mode: 0o600 });
    return { key, cert, pem: pair.cert };
  }
  writeFileSync(extensions,
    `basicConstraints=critical,CA:${issuer ? 'FALSE' : 'TRUE'}\nsubjectAltName=DNS:${hostname}\n`);
  if (issuer) {
    command('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
      '-out', csr, '-subj', `/CN=${hostname}`]);
    const signing = issuer
      ? ['-CA', issuer.cert, '-CAkey', issuer.key, '-set_serial', '2']
      : ['-signkey', key];
    command('openssl', ['x509', '-req', '-in', csr, ...signing, '-out', cert,
      '-days', '2', '-extfile', extensions]);
  } else {
    command('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-keyout', key, '-out', cert, '-subj', `/CN=${hostname}`,
      '-addext', `subjectAltName=DNS:${hostname}`]);
  }
  return { key, cert, pem: readFileSync(cert, 'utf8') };
}

function connection(nodes) {
  return { pageInfo: { hasNextPage: false }, edges: nodes.map(node => ({ node })) };
}

function metadata({ expanded = false, drift = false } = {}) {
  const serviceIds = [TARGET.databaseServiceId, TARGET.webServiceId, TARGET.workerServiceId];
  return {
    project: { id: TARGET.projectId, deletedAt: null,
      services: connection(serviceIds.map(id => ({ id }))) },
    environment: {
      id: TARGET.environmentId, projectId: TARGET.projectId, name: TARGET.environmentName,
      canAccess: true, deletedAt: null,
      serviceInstances: connection(serviceIds.map((serviceId, role) => ({
        serviceId, environmentId: TARGET.environmentId, numReplicas: null,
        activeDeployments: [{
          id: fixtureId(drift && role === 1 ? 99 : role + 1), status: 'SUCCESS',
          deploymentStopped: false,
          instances: Array.from({ length: expanded ? 100 : 1 }, (_, i) => ({
            id: fixtureId(1000 + role * 100 + i), status: 'RUNNING',
          })),
          meta: { commitHash: sourceSha, cliMessage: `GitHub auto deploy ${sourceSha}`,
            imageDigest: `sha256:${'b'.repeat(64)}`, ignoredSecret: token },
        }],
      }))),
    },
  };
}

async function captureTlsSession() {
  const rows = (await admin.query(`SELECT s.ssl, s.version, s.cipher
    FROM pg_stat_activity a JOIN pg_stat_ssl s USING (pid)
    WHERE a.application_name=$1`, [applicationName])).rows;
  check(rows.length === 1 && rows[0].ssl === true, 'ACTUAL_DATABASE_TLS_NOT_OBSERVED');
  currentCase.tls = { authorizedServerSession: true, protocol: rows[0].version,
    cipher: rows[0].cipher };
}

async function handleMetadata(request, response) {
  const active = currentCase;
  check(active, 'METADATA_OUTSIDE_CASE');
  active.metadataCalls += 1;
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
    check(chunks.reduce((sum, item) => sum + item.length, 0) <= 8192,
      'METADATA_REQUEST_TOO_LARGE');
  }
  check(request.method === 'POST' && request.url === '/graphql/v2'
    && request.headers['project-access-token'] === token,
  'ACTUAL_METADATA_REQUEST_INVALID');
  check(JSON.stringify(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    === JSON.stringify({ query: PRODUCTION_METADATA_QUERY }), 'ACTUAL_METADATA_QUERY_INVALID');
  response.writeHead(200, { 'content-type': 'application/json' });
  if (active.metadataMode === 'timeout') {
    response.write('{');
    response.once('close', () => { active.metadataStreamCancelled = true; });
    return;
  }
  if (active.metadataMode === 'oversized') {
    let bytes = 0;
    const interval = setInterval(() => {
      bytes += 65536;
      response.write('x'.repeat(65536));
      if (bytes >= 3 * 1024 * 1024) { clearInterval(interval); response.end(); }
    }, 4);
    response.once('close', () => {
      clearInterval(interval);
      active.metadataStreamCancelled = bytes < 3 * 1024 * 1024;
    });
    return;
  }
  if (active.metadataMode === 'provider-error') {
    response.end(JSON.stringify({ errors: [{ message: `${token} ${password}` }] }));
    return;
  }
  if (active.metadataCalls === 2) await captureTlsSession();
  // Two writes force the normal response through the streamed reader too.
  const body = JSON.stringify({ data: metadata({ expanded: active.expanded,
    drift: active.metadataMode === 'drift' && active.metadataCalls === 2 }) });
  response.write(body.slice(0, 37));
  response.end(body.slice(37));
}

async function fingerprint() {
  const sentinel = (await admin.query('SELECT * FROM public.inspection_fixture_sentinel ORDER BY id')).rows;
  const exists = (await admin.query("SELECT to_regclass('public.job_events') IS NOT NULL AS present")).rows[0].present;
  const events = exists ? (await admin.query('SELECT * FROM public.job_events ORDER BY id')).rows : [];
  const catalog = (await admin.query(`SELECT c.relname, a.attname,
    format_type(a.atttypid,a.atttypmod) AS data_type, a.attnotnull
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' ORDER BY c.relname,a.attname`)).rows;
  const definitions = (await admin.query(`SELECT conname AS name, pg_get_constraintdef(oid) AS definition
    FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public'
    ORDER BY name,definition`)).rows;
  return sha256(JSON.stringify({ sentinel, events, catalog, definitions }));
}

async function resetSchema() {
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.query(readFileSync(join(fixtureDirectory, 'fixture-schema.sql'), 'utf8'));
  await admin.query('GRANT USAGE ON SCHEMA public TO inspection_fixture_reader; GRANT SELECT ON ALL TABLES IN SCHEMA public TO inspection_fixture_reader;');
}

async function setDatabaseCertificate(pair) {
  copyFileSync(pair.cert, join(temporaryDirectory, 'server.crt'));
  copyFileSync(pair.key, join(temporaryDirectory, 'server.key'));
  const uid = Number(command('id', ['-u', 'postgres']).trim());
  const gid = Number(command('id', ['-g', 'postgres']).trim());
  for (const filename of ['server.crt', 'server.key']) {
    const path = join(temporaryDirectory, filename);
    chownSync(path, uid, gid);
    chmodSync(path, 0o600);
  }
  if (clusterStarted) {
    const before = (await admin.query('SELECT pg_conf_load_time()::text AS value')).rows[0].value;
    postgresCommand('pg_ctl', ['-D', join(temporaryDirectory, 'data'), 'reload']);
    for (let i = 0; i < 100; i += 1) {
      const after = (await admin.query('SELECT pg_conf_load_time()::text AS value')).rows[0].value;
      if (after !== before) return;
      await delay(20);
    }
    throw new Error('FIXTURE_DATABASE_CERTIFICATE_RELOAD_TIMEOUT');
  }
}

function collectorEnvironment(directory, certificatePem) {
  return {
    PATH: `${join(temporaryDirectory, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
    LANG: 'C.UTF-8', NODE_EXTRA_CA_CERTS: join(temporaryDirectory, 'metadata.crt'),
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'pbjustin/Arcanos',
    GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main',
    GITHUB_WORKFLOW_REF: 'pbjustin/Arcanos/.github/workflows/railway-auto-deploy.yml@refs/heads/main',
    DEPLOY_REF: sourceSha, GITHUB_WORKFLOW_SHA: sourceSha, GITHUB_SHA: sourceSha,
    RAILWAY_TOKEN: token, RAILWAY_PRODUCTION_DATABASE_CERTIFICATE: certificatePem,
    RUNNER_TEMP: directory, GITHUB_OUTPUT: join(directory, 'github-output'),
    FIXTURE_VARIABLES_FILE: join(temporaryDirectory, 'variables.json'),
    FIXTURE_CLI_CALLS_FILE: join(directory, 'cli-calls'),
    FIXTURE_CLI_PID_FILE: join(directory, 'cli-pid'),
    FIXTURE_CLI_MODE: currentCase.cliMode ?? 'normal',
  };
}

function executeCollector(environment) {
  return new Promise(resolvePromise => {
    execFile(process.execPath, [join(root, 'scripts/railway-production-readonly-inspection.mjs')], {
      cwd: root, env: environment, encoding: 'utf8', timeout: 45000,
      killSignal: 'SIGKILL', maxBuffer: 128 * 1024,
    }, (error, stdout, stderr) => {
      resolvePromise({ exitCode: error ? (Number.isInteger(error.code) ? error.code : null) : 0,
        timedOut: error?.killed === true, stdout, stderr });
    });
  });
}

function actualStatements(log) {
  const prefix = /^FIXTURE \[\d+\] \[([^\]]*)\] /gmu;
  const records = [...log.matchAll(prefix)];
  return records.flatMap((record, i) => {
    if (record[1] !== applicationName) return [];
    const block = log.slice(record.index + record[0].length, records[i + 1]?.index ?? log.length);
    const statement = /^(?:LOG:\s+)?statement: ([\s\S]*)$/u.exec(block.trim());
    return statement ? [normalizeSql(statement[1])] : [];
  });
}

async function ensureNoSession() {
  for (let i = 0; i < 100; i += 1) {
    const count = (await admin.query('SELECT count(*)::integer AS value FROM pg_stat_activity WHERE application_name=$1', [applicationName])).rows[0].value;
    if (count === 0) return;
    await delay(20);
  }
  throw new Error('COLLECTOR_SESSION_NOT_CLOSED');
}

async function runCase(name, options = {}) {
  check(requiredFixtureCases(postgresMajor)[proof.cases.length] === name, 'FIXTURE_CASE_ORDER_INVALID');
  const caseProof = { name, status: 'FAIL' };
  proof.cases.push(caseProof);
  currentCase = { ...options, metadataCalls: 0, metadataStreamCancelled: false,
    serverFailure: false, tls: undefined, expectedInventoryBytes: undefined };
  const directory = join(temporaryDirectory, name);
  mkdirSync(directory, { mode: 0o700 });
  await resetSchema();
  if (options.setup) await options.setup();
  const before = await fingerprint();
  const logOffset = statSync(join(temporaryDirectory, 'postgres.log')).size;
  const receiptPath = join(directory, INSPECTION_RECEIPT_FILENAME);
  const protectedPath = join(directory, 'protected-fixture');
  const preserved = '{"fixture":"preserved"}\n';
  if (options.writer === 'existing') writeFileSync(receiptPath, preserved, { mode: 0o600 });
  if (options.writer === 'symlink') {
    writeFileSync(protectedPath, preserved, { mode: 0o600 });
    symlinkSync(protectedPath, receiptPath);
  }
  const environment = { ...collectorEnvironment(directory,
    options.certificatePem ?? currentCase.defaultCertificatePem), ...options.environment };
  const startedAt = Date.now();
  const result = await executeCollector(environment);
  const elapsedMs = Date.now() - startedAt;
  check(!result.timedOut, `${name}_COLLECTOR_HARNESS_TIMEOUT`);
  check(![token, password].some(secret => result.stdout.includes(secret) || result.stderr.includes(secret)),
    `${name}_OUTPUT_CREDENTIAL_LEAK`);
  await ensureNoSession();
  check(await fingerprint() === before, `${name}_DATABASE_MUTATED`);
  const log = readFileSync(join(temporaryDirectory, 'postgres.log')).subarray(logOffset).toString('utf8');
  const statements = actualStatements(log);
  const expectedStatements = ['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'SET LOCAL search_path = pg_catalog, public', ...Object.values(CATALOG_QUERIES), 'ROLLBACK'].map(normalizeSql);
  const output = existsSync(environment.GITHUB_OUTPUT) ? readFileSync(environment.GITHUB_OUTPUT, 'utf8') : '';
  const cliCalls = existsSync(environment.FIXTURE_CLI_CALLS_FILE)
    ? readFileSync(environment.FIXTURE_CLI_CALLS_FILE, 'utf8').trim().split('\n').length : 0;
  if (cliCalls > 0) {
    const pid = Number(readFileSync(environment.FIXTURE_CLI_PID_FILE, 'utf8').trim());
    check(Number.isInteger(pid) && pid > 1, `${name}_CLI_PID_INVALID`);
    let terminated = false;
    for (let i = 0; i < 100; i += 1) {
      try { process.kill(pid, 0); }
      catch (error) { check(error.code === 'ESRCH', `${name}_CLI_PROCESS_INSPECTION_FAILED`); terminated = true; break; }
      await delay(20);
    }
    check(terminated, `${name}_CLI_PROCESS_NOT_TERMINATED`);
    caseProof.cliSubprocessTerminated = true;
  }
  check(result.exitCode === (options.exitCode ?? (options.errorCode ? 1 : 0)), `${name}_EXIT_CODE_UNEXPECTED`);
  check(currentCase.metadataCalls === (options.metadataCalls ?? 2), `${name}_METADATA_CALL_COUNT_INVALID`);
  check(cliCalls === (options.cliCalls ?? 1), `${name}_CLI_CALL_COUNT_INVALID`);
  if (options.noReceipt || options.writer) {
    check(output === '', `${name}_UNEXPECTED_OUTPUT_MARKER`);
    if (options.writer === 'existing') check(readFileSync(receiptPath, 'utf8') === preserved, `${name}_OVERWROTE_EXISTING_RECEIPT`);
    else if (options.writer === 'symlink') {
      check(lstatSync(receiptPath).isSymbolicLink() && readFileSync(protectedPath, 'utf8') === preserved,
        `${name}_FOLLOWED_RECEIPT_SYMLINK`);
    } else check(!existsSync(receiptPath), `${name}_UNEXPECTED_RECEIPT`);
  } else {
    const serialized = readFileSync(receiptPath, 'utf8');
    check(Buffer.byteLength(serialized) <= 65536 && (statSync(receiptPath).mode & 0o777) === 0o600,
      `${name}_RECEIPT_BOUNDS_OR_PERMISSIONS_INVALID`);
    check(![token, password].some(secret => serialized.includes(secret)), `${name}_RECEIPT_CREDENTIAL_LEAK`);
    const receipt = JSON.parse(serialized);
    check(receipt.status === (options.errorCode ? 'BLOCKED' : 'COLLECTION_COMPLETE'), `${name}_RECEIPT_STATUS_INVALID`);
    check(receipt.inspectionSourceSha === sourceSha && receipt.contractVerdict === 'NOT_EVALUATED'
      && receipt.runningSourceVerdict === 'UNVERIFIED' && receipt.deploymentPerformed === false
      && receipt.migrationPerformed === false && receipt.holdCleared === false,
    `${name}_RECEIPT_AUTHORITY_ESCALATED`);
    check(output === 'inspection_receipt_written=true\n', `${name}_OUTPUT_MARKER_INVALID`);
    if (options.errorCode) check([options.errorCode].flat().includes(receipt.errorCode), `${name}_RECEIPT_ERROR_INVALID`);
    if (options.stage) check(receipt.failedStage === options.stage, `${name}_RECEIPT_STAGE_INVALID`);
    writeFileSync(join(proofDirectory, `${name}.json`), serialized, { mode: 0o600, flag: 'wx' });
    Object.assign(caseProof, { receiptStatus: receipt.status, receiptBytes: Buffer.byteLength(serialized),
      receiptMode: '0600', outputMarker: true });
    if (receipt.database) caseProof.databaseReadOnly = receipt.database.readOnly;
    if (receipt.errorCode) caseProof.errorCode = receipt.errorCode;
    if (options.inspectReceipt) await options.inspectReceipt(receipt);
  }
  if (options.sql === 'none') check(statements.length === 0, `${name}_UNEXPECTED_DATABASE_SQL`);
  else if (options.sql === 'partial') {
    check(JSON.stringify(statements) === JSON.stringify([...expectedStatements.slice(0, 5), 'ROLLBACK']),
      `${name}_SQL_NOT_READ_ONLY`);
  } else {
    check(JSON.stringify(statements) === JSON.stringify(expectedStatements), `${name}_ACTUAL_SQL_SEQUENCE_INVALID`);
  }
  if (!options.errorCode && !options.noReceipt) check(currentCase.tls?.authorizedServerSession === true,
    `${name}_TLS_NOT_PROVEN`);
  Object.assign(caseProof, { exitCode: result.exitCode, elapsedMs,
    metadataRequests: currentCase.metadataCalls, boundedCliProcesses: cliCalls,
    actualSqlStatementCount: statements.length, rollbackObserved: statements.at(-1) === 'ROLLBACK',
    actualSqlStatementKinds: statements.map(statement => statement.split(' ')[0]),
    databaseFingerprintUnchanged: true, collectorSessionsRemaining: 0 });
  if (currentCase.tls) caseProof.databaseTls = currentCase.tls;
  if (currentCase.expectedInventoryBytes) caseProof.expectedInventoryBytes = currentCase.expectedInventoryBytes;
  if (options.metadataMode === 'oversized' || options.metadataMode === 'timeout') {
    check(currentCase.metadataStreamCancelled === true, `${name}_METADATA_STREAM_NOT_CANCELLED`);
    caseProof.metadataStreamCancelled = true;
  }
  if (options.cliMode === 'timeout') {
    check(elapsedMs >= 29000 && elapsedMs < 35000, `${name}_CLI_TIMEOUT_BOUND_INVALID`);
  }
  caseProof.status = 'PASS';
  process.stdout.write(`${name}: PASS\n`);
}

async function main() {
  proof.setupStage = 'input';
  if (existsSync(join(root, 'source-context.json'))) {
    proof.sourceContextSha256 = sha256(readFileSync(join(root, 'source-context.json')));
  }
  check(process.version === 'v24.18.1', 'FIXTURE_PINNED_NODE_REQUIRED');
  check([17, 18].includes(postgresMajor) && /^[0-9a-f]{40}$/u.test(sourceSha ?? ''), 'FIXTURE_INPUT_INVALID');
  check(command('git', ['rev-parse', 'HEAD'], { cwd: root }).trim() === sourceSha, 'FIXTURE_SOURCE_CHECKOUT_MISMATCH');
  check(process.getuid() === 0, 'FIXTURE_CONTAINER_ROOT_REQUIRED');
  const hosts = readFileSync('/etc/hosts', 'utf8').split('\n')
    .map(line => line.split('#')[0].trim().split(/\s+/u));
  for (const hostname of ['backboard.railway.com', TARGET.proxyHost]) {
    const matches = hosts.filter(fields => fields.slice(1).includes(hostname));
    check(matches.length === 1 && matches[0][0] === '127.0.0.1', 'FIXTURE_LOOPBACK_HOST_ALIASES_REQUIRED');
  }
  const routes = readFileSync('/proc/net/route', 'utf8').trim().split('\n').slice(1);
  check(routes.every(line => line.trim().split(/\s+/u)[1] !== '00000000'),
    'FIXTURE_NO_NETWORK_ROUTE_REQUIRED');
  proof.providerHostAliasesLoopback = true;
  proof.defaultNetworkRouteAbsent = true;
  proof.setupStage = 'temporary-files';
  mkdirSync(proofDirectory, { recursive: true });
  temporaryDirectory = mkdtempSync(join(tmpdir(), 'arcanos-inspection-e2e-'));
  chmodSync(temporaryDirectory, 0o755);
  const databasePair = generateCertificate('database', 'fixture.invalid');
  const otherPair = generateCertificate('other-database', 'fixture.invalid');
  const trustedAlternate = generateCertificate('trusted-alternate', 'alternate.fixture.invalid', { issuer: databasePair });
  const expiredPair = generateCertificate('expired-database', 'fixture.invalid', { expired: true });
  const metadataPair = generateCertificate('metadata', 'backboard.railway.com');
  mkdirSync(join(temporaryDirectory, 'bin'));
  copyFileSync(join(fixtureDirectory, 'railway.mjs'), join(temporaryDirectory, 'bin', 'railway'));
  chmodSync(join(temporaryDirectory, 'bin', 'railway'), 0o755);
  writeFileSync(join(temporaryDirectory, 'variables.json'), JSON.stringify({
    RAILWAY_PROJECT_ID: TARGET.projectId, RAILWAY_ENVIRONMENT_ID: TARGET.environmentId,
    RAILWAY_SERVICE_ID: TARGET.databaseServiceId, RAILWAY_TCP_PROXY_DOMAIN: TARGET.proxyHost,
    RAILWAY_TCP_PROXY_PORT: TARGET.proxyPort, PGDATABASE: TARGET.databaseName,
    PGUSER: 'inspection_fixture_reader', PGPASSWORD: password, ignoredSecret: token,
  }), { mode: 0o600 });
  const uid = Number(command('id', ['-u', 'postgres']).trim());
  const gid = Number(command('id', ['-g', 'postgres']).trim());
  mkdirSync(join(temporaryDirectory, 'data'), { mode: 0o700 });
  chownSync(join(temporaryDirectory, 'data'), uid, gid);
  mkdirSync(join(temporaryDirectory, 'socket'), { mode: 0o700 });
  chownSync(join(temporaryDirectory, 'socket'), uid, gid);
  writeFileSync(join(temporaryDirectory, 'postgres.log'), '', { mode: 0o600 });
  chownSync(join(temporaryDirectory, 'postgres.log'), uid, gid);
  proof.setupStage = 'postgres-initdb';
  postgresCommand('initdb', ['-D', join(temporaryDirectory, 'data'), '--auth-local=trust',
    '--auth-host=trust', '--username=postgres', '--no-instructions']);
  await setDatabaseCertificate(databasePair);
  proof.setupStage = 'postgres-configure';
  appendFileSync(join(temporaryDirectory, 'data', 'postgresql.conf'), `
listen_addresses='127.0.0.1'
port=${TARGET.proxyPort}
unix_socket_directories='${join(temporaryDirectory, 'socket')}'
ssl=on
ssl_cert_file='${join(temporaryDirectory, 'server.crt')}'
ssl_key_file='${join(temporaryDirectory, 'server.key')}'
log_statement='all'
log_line_prefix='FIXTURE [%p] [%a] '
log_connections=on
log_disconnections=on
`);
  writeFileSync(join(temporaryDirectory, 'data', 'pg_hba.conf'),
    'local all all trust\nhostssl railway inspection_fixture_reader 127.0.0.1/32 scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\n');
  proof.setupStage = 'postgres-start';
  postgresCommand('pg_ctl', ['-D', join(temporaryDirectory, 'data'), '-l',
    join(temporaryDirectory, 'postgres.log'), '-w', '-t', '10', 'start']);
  clusterStarted = true;
  const adminOptions = { host: join(temporaryDirectory, 'socket'), port: Number(TARGET.proxyPort),
    user: 'postgres', application_name: 'inspection_fixture_admin',
    connectionTimeoutMillis: 2000, query_timeout: 5000 };
  proof.setupStage = 'admin-connect';
  admin = new Client({ ...adminOptions, database: 'postgres' });
  await admin.connect();
  proof.setupStage = 'admin-create-database';
  await admin.query('CREATE DATABASE railway');
  await admin.query(`CREATE ROLE inspection_fixture_reader LOGIN PASSWORD ${sqlLiteral(password)}`);
  await admin.end();
  admin = new Client({ ...adminOptions, database: 'railway' });
  proof.setupStage = 'admin-reconnect';
  await admin.connect();
  metadataServer = createServer({ key: readFileSync(metadataPair.key), cert: readFileSync(metadataPair.cert) },
    (request, response) => { handleMetadata(request, response).catch(() => {
      if (currentCase) currentCase.serverFailure = true;
      response.destroy();
    }); });
  metadataServer.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket));
  });
  proof.setupStage = 'metadata-server-listen';
  await new Promise((resolvePromise, reject) => {
    metadataServer.once('error', reject); metadataServer.listen(443, '127.0.0.1', resolvePromise);
  });
  proof.setupStage = 'cases';
  const common = { defaultCertificatePem: databasePair.pem };
  await runCase('complete-catalog', { ...common, inspectReceipt: receipt => {
    assert.equal(Math.floor(receipt.database.serverVersionNum / 10000), postgresMajor);
    assert.equal(receipt.database.readOnly, true);
    assert.equal(receipt.database.jobEventsExists, true);
    assert.equal(receipt.connectionClosed, true);
    assert.equal(receipt.metadataStable, true);
    assert.equal(receipt.columns.length, 7);
    const types = Object.fromEntries(receipt.columns.map(column => [column.attname, column.data_type]));
    assert.deepEqual(types, { claim_generation: 'bigint', event_type: 'text', id: 'uuid', job_id: 'uuid',
      occurred_at: 'timestamp with time zone', operation: 'character varying(200)',
      stats_worker_id: 'character varying(255)' });
    assert.equal(receipt.columns.find(column => column.attname === 'stats_worker_id').collation, '"C"');
    assert.equal(receipt.columns.find(column => column.attname === 'occurred_at').has_default, true);
    assert.equal(receipt.columns.every(column => column.attidentity === '' && column.attgenerated === ''), true);
    assert.equal(receipt.constraints.length, 1);
    assert.equal(receipt.constraints[0].enforced, true);
    assert.equal(receipt.constraints[0].convalidated, true);
    assert.equal(receipt.constraints[0].contype, 'c');
    assert.deepEqual(receipt.constraints[0].conkey, [4, 9, 10]);
    assert.match(receipt.constraints[0].expression, /claim_generation > 0/u);
    assert.match(receipt.constraints[0].expression, /stats_worker_id IS NOT NULL/u);
    assert.match(receipt.constraints[0].expression, /worker\.budget\.job_claim/u);
    assert.match(receipt.constraints[0].expression, /worker\.budget\.ai_provider_attempt/u);
    assert.equal(receipt.indexes.length, 2);
    assert.equal(receipt.indexes.every(index => Array.isArray(index.indkey)), true);
    const indexes = Object.fromEntries(receipt.indexes.map(index => [index.relname, index]));
    const claim = indexes.idx_job_events_worker_budget_claim_generation;
    const group = indexes.idx_job_events_worker_budget_group_window;
    assert.deepEqual(claim.indkey, [2, 10]);
    assert.equal(claim.indisunique, true);
    assert.match(claim.definition, /USING btree \(job_id, claim_generation\)/u);
    assert.equal(normalizeSql(claim.predicate).replace(/^\((.*)\)$/u, '$1'),
      "event_type = 'worker.budget.job_claim'::text");
    assert.deepEqual(group.indkey, [9, 4, 6, 1]);
    assert.equal(group.indisunique, false);
    assert.match(group.definition, /USING btree \(stats_worker_id, event_type, occurred_at, id\)/u);
    assert.match(group.predicate, /worker\.budget\.job_claim/u);
    assert.match(group.predicate, /worker\.budget\.ai_provider_attempt/u);
    assert.equal(receipt.indexes.every(index => index.indisvalid && index.indisready && index.indislive
      && !index.indisprimary && !index.indisexclusion && index.amname === 'btree'), true);
  } });
  await runCase('absent-catalog', { ...common, setup: async () => { await admin.query('DROP TABLE public.job_events'); },
    inspectReceipt: receipt => {
      assert.equal(receipt.database.jobEventsExists, false);
      assert.deepEqual([receipt.columns, receipt.constraints, receipt.indexes], [[], [], []]);
    } });
  await runCase('incomplete-catalog', { ...common, setup: async () => {
    await admin.query(`ALTER TABLE public.job_events DROP CONSTRAINT job_events_worker_budget_shape_check;
      DROP INDEX public.idx_job_events_worker_budget_group_window;
      DROP INDEX public.idx_job_events_worker_budget_claim_generation;`);
  }, inspectReceipt: receipt => {
    assert.equal(receipt.database.jobEventsExists, true);
    assert.equal(receipt.columns.length, 7);
    assert.deepEqual([receipt.constraints, receipt.indexes], [[], []]);
  } });
  if (postgresMajor === 18) await runCase('not-enforced-constraint', { ...common, setup: async () => {
    await admin.query(`ALTER TABLE public.job_events DROP CONSTRAINT job_events_worker_budget_shape_check;
      ALTER TABLE public.job_events ADD CONSTRAINT job_events_worker_budget_shape_check
        CHECK (claim_generation > 0) NOT ENFORCED;
      INSERT INTO public.job_events(id,job_id,event_type,claim_generation)
      VALUES ('30000000-1111-4111-8111-111111111111','40000000-1111-4111-8111-111111111111','fixture.invalid-budget',0);`);
  }, inspectReceipt: receipt => {
    assert.equal(receipt.constraints.length, 1);
    assert.equal(receipt.constraints[0].enforced, false);
    assert.match(receipt.constraints[0].definition, /NOT ENFORCED/u);
    assert.equal(receipt.constraints[0].expression, '(claim_generation > 0)');
  } });
  await runCase('metadata-drift', { ...common, metadataMode: 'drift', errorCode: 'ACTIVE_DEPLOYMENT_DRIFT', stage: 'metadata_after' });
  for (const [name, credential] of [['catalog-token-leak', token], ['catalog-password-leak', password]]) {
    await runCase(name, { ...common, errorCode: 'CATALOG_CREDENTIAL_LEAK', stage: 'constraints',
      metadataCalls: 1, sql: 'partial', setup: async () => {
        await admin.query(`ALTER TABLE public.job_events DROP CONSTRAINT job_events_worker_budget_shape_check;
          ALTER TABLE public.job_events ADD CONSTRAINT job_events_worker_budget_shape_check
          CHECK (operation <> ${sqlLiteral(credential)})`);
      }, inspectReceipt: receipt => assert.equal('constraints' in receipt, false) });
  }
  await runCase('oversized-receipt', { ...common, expanded: true,
    errorCode: 'RECEIPT_TOO_LARGE', stage: 'receipt', setup: async () => {
      const padding = sqlLiteral('x'.repeat(5500));
      await admin.query(`ALTER TABLE public.job_events DROP CONSTRAINT job_events_worker_budget_shape_check;
        ALTER TABLE public.job_events ADD CONSTRAINT job_events_worker_budget_shape_check CHECK (operation <> ${padding});
        DROP INDEX public.idx_job_events_worker_budget_group_window;
        DROP INDEX public.idx_job_events_worker_budget_claim_generation;
        CREATE INDEX idx_job_events_worker_budget_group_window ON public.job_events(stats_worker_id,event_type,occurred_at,id) WHERE event_type <> ${padding};
        CREATE INDEX idx_job_events_worker_budget_claim_generation ON public.job_events(job_id,claim_generation) WHERE event_type <> ${padding};`);
      const inventory = JSON.parse(readFileSync(join(proofDirectory, 'complete-catalog.json'), 'utf8'));
      inventory.deployments = sanitizeProductionMetadata(metadata({ expanded: true }));
      for (const kind of ['columns', 'constraints', 'indexes']) {
        inventory[kind] = (await admin.query(CATALOG_QUERIES[kind])).rows;
      }
      const compact = Buffer.byteLength(JSON.stringify(inventory));
      const serialized = Buffer.byteLength(`${JSON.stringify(inventory, null, 2)}\n`);
      check(compact <= 65536 && serialized > 65536, 'FIXTURE_PRETTY_RECEIPT_REGRESSION_NOT_REPRODUCED');
      currentCase.expectedInventoryBytes = { compact, serialized };
    }, inspectReceipt: receipt => {
      assert.equal(receipt.connectionClosed, true);
      assert.equal('deployments' in receipt, false);
      assert.equal('constraints' in receipt, false);
    } });
  await runCase('database-untrusted', { ...common, certificatePem: '',
    errorCode: 'INSPECTION_READ_FAILED', stage: 'connecting', metadataCalls: 1, sql: 'none' });
  await runCase('database-wrong-pin', { ...common, certificatePem: otherPair.pem,
    errorCode: 'INSPECTION_READ_FAILED', stage: 'connecting', metadataCalls: 1, sql: 'none' });
  await setDatabaseCertificate(trustedAlternate);
  await runCase('database-different-trusted-peer', { ...common,
    errorCode: 'DATABASE_CERTIFICATE_MISMATCH', stage: 'connecting', metadataCalls: 1, sql: 'none' });
  await setDatabaseCertificate(expiredPair);
  await runCase('database-expired-pin', { ...common, certificatePem: expiredPair.pem,
    errorCode: 'INSPECTION_READ_FAILED', stage: 'connecting', metadataCalls: 1, sql: 'none' });
  await setDatabaseCertificate(databasePair);
  await runCase('metadata-output-limit', { ...common, metadataMode: 'oversized',
    errorCode: 'METADATA_TOO_LARGE', stage: 'metadata_before', metadataCalls: 1, cliCalls: 0, sql: 'none' });
  await runCase('metadata-stream-timeout', { ...common, metadataMode: 'timeout',
    errorCode: 'METADATA_TIMEOUT', stage: 'metadata_before', metadataCalls: 1, cliCalls: 0, sql: 'none' });
  await runCase('metadata-provider-error', { ...common, metadataMode: 'provider-error',
    errorCode: 'PROVIDER_READ_FAILED', stage: 'metadata_before', metadataCalls: 1, cliCalls: 0, sql: 'none' });
  await runCase('cli-output-limit', { ...common, cliMode: 'oversized',
    errorCode: 'INSPECTION_READ_FAILED', stage: 'variables', metadataCalls: 1, sql: 'none' });
  await runCase('cli-provider-error', { ...common, cliMode: 'failure',
    errorCode: 'INSPECTION_READ_FAILED', stage: 'variables', metadataCalls: 1, sql: 'none' });
  await runCase('cli-timeout', { ...common, cliMode: 'timeout',
    // The independent collector and execFile deadlines both expire at 30 seconds.
    errorCode: ['VARIABLE_READ_TIMEOUT', 'INSPECTION_READ_FAILED'], stage: 'variables', metadataCalls: 1, sql: 'none' });
  await runCase('trusted-main-gate', { ...common, environment: { GITHUB_EVENT_NAME: 'pull_request' },
    noReceipt: true, exitCode: 1, metadataCalls: 0, cliCalls: 0, sql: 'none' });
  const wrongSha = sourceSha === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  await runCase('trusted-checkout-gate', { ...common,
    environment: { DEPLOY_REF: wrongSha, GITHUB_SHA: wrongSha, GITHUB_WORKFLOW_SHA: wrongSha },
    noReceipt: true, exitCode: 1, metadataCalls: 0, cliCalls: 0, sql: 'none' });
  await runCase('exclusive-existing-receipt', { ...common, writer: 'existing', exitCode: 1 });
  await runCase('exclusive-symlink-receipt', { ...common, writer: 'symlink', exitCode: 1 });
  check(proof.cases.every(item => item.status === 'PASS'), 'FIXTURE_CASE_INCOMPLETE');
  assert.deepEqual(proof.cases.map(item => item.name), requiredFixtureCases(postgresMajor));
  proof.setupStage = 'complete';
  proof.status = 'PASS';
}

try {
  await main();
} catch (error) {
  // Assertions and driver errors may contain SQL/credentials; retain only a code.
  proof.failureCode = /^[A-Za-z0-9_-]{1,120}$/u.test(error?.message ?? '')
    ? error.message : 'FIXTURE_ASSERTION_FAILED';
  process.stderr.write(`${proof.failureCode}\n`);
  process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.destroy();
  if (metadataServer?.listening) await new Promise(resolvePromise => metadataServer.close(resolvePromise));
  if (admin) { try { await admin.end(); } catch {} }
  if (clusterStarted) {
    try { postgresCommand('pg_ctl', ['-D', join(temporaryDirectory, 'data'), '-m', 'immediate', '-w', '-t', '5', 'stop']); }
    catch { proof.status = 'FAIL'; proof.cleanupFailure = 'FIXTURE_DATABASE_STOP_FAILED'; process.exitCode = 1; }
  }
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  mkdirSync(proofDirectory, { recursive: true });
  writeFileSync(join(proofDirectory, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  process.stdout.write(`inspection fixture PG${postgresMajor}: ${proof.status} (${proof.cases.filter(item => item.status === 'PASS').length}/${proof.cases.length})\n`);
}
