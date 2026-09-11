import { afterAll, beforeAll, describe, expect, jest, test } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { validateDatabaseUrl } from '../../scripts/validate-ios-device-gateway-e2e.mjs';

// This suite is deliberately separate from the fast synthetic Gateway proof.
// The outer runner supplies a clean child environment and an exact Swift binary.
const enabled = process.env.IOS_DEVICE_E2E === '1';
if (process.env.IOS_DEVICE_E2E && !enabled) throw new Error('IOS_DEVICE_E2E must be 1 when set.');
const run = enabled ? describe : describe.skip;
const assertionNames = [
  'swift_client_flow', 'pairing_persisted_hashed_only',
  'ai_job_persisted_with_device_owner', 'ai_worker_claim_executed_and_fenced',
  'provider_fixture_called', 'local_agent_confirmation_single_enqueue',
  'local_agent_executor_result_persisted', 'device_rotation_and_revocation_persisted',
  'cross_device_job_reads_denied', 'secret_free_report',
  'local_agent_device_idempotency_isolated',
] as const;
const assertions = new Map<string, boolean>(assertionNames.map(name => [name, false]));
const swiftAssertionNames = [
  'unpaired_local_without_network', 'unpaired_remote_blocked', 'distinct_devices_paired_and_inspected',
  'one_use_pairing_replay_denied', 'device_ai_job_completed_and_owned_result_read', 'other_device_job_read_denied',
  'declined_confirmation_sends_no_retry', 'explicit_approval_retries_once', 'approved_tests_job_completed',
  'renewal_rotates_and_old_credential_is_denied', 'revocation_blocks_subsequent_client_requests',
];
const origin = 'https://device-e2e.example.invalid';
const answer = 'Synthetic device E2E answer.';
const executorId = 'ee000000-0000-4000-8000-000000000001';
const operatorToken = 'isolated-ios-e2e-operator-' + randomUUID();
const executorToken = 'isolated-ios-e2e-executor-' + randomUUID();
const schema = 'ios_device_e2e_' + (process.env.IOS_DEVICE_E2E_RUN_ID ?? '').replaceAll('-', '');
const rawFetch = globalThis.fetch;
let providerCalls = 0;
let server: Server | undefined;
let admin: Pool | undefined;
let memoryDirectory: string | undefined;
let schemaCreated = false;
let schemaRemoved = false;
let serverClosed = false;
let completed = false;
let stop = false;
let draining: Promise<void> | undefined;
let drainError: unknown;
let aiExecutions = 0;
let executorExecutions = 0;
let deniedPeerReads = 0;
let swiftReport: Record<string, unknown> | undefined;
let db: typeof import('../../src/core/db/client.js');
let jobs: typeof import('../../src/core/db/repositories/jobRepository.js');
let localJobs: typeof import('../../src/core/db/repositories/localAgentJobRepository.js');
let worker: typeof import('../../src/workers/jobRunner.js');
let app: express.Express;
let baseURL: string;
let pairingA: string;
let pairingB: string;
const secrets: string[] = [operatorToken, executorToken];
let signalListeners: { SIGINT: NodeJS.SignalsListener[]; SIGTERM: NodeJS.SignalsListener[] };

function check(name: typeof assertionNames[number], condition: boolean): void {
  assertions.set(name, condition);
  expect(condition).toBe(true);
}

// Only the remote provider transport is synthetic: SDK, adapter, Trinity,
// canonical dispatcher and queued worker execution remain production code.
const providerFetch: typeof fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== 'https://provider-e2e.example.invalid') {
    throw new Error('Unexpected external request rejected by iOS E2E fixture.');
  }
  providerCalls += 1;
  if (providerCalls > 20) throw new Error('Provider fixture request bound exceeded.');
  const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
  const prompt = JSON.stringify(body);
  const structured = { response_mode: 'answer', achievable_subtasks: [], blocked_subtasks: [],
    user_visible_caveats: [], claim_tags: [], final_answer: answer };
  const content = prompt.includes('trinity_structured_reasoning_compact')
    ? JSON.stringify(structured)
    : prompt.includes('trinity_structured_reasoning')
    ? JSON.stringify({ ...structured, reasoning_steps: [], assumptions: [], constraints: [], tradeoffs: [],
      alternatives_considered: [], chosen_path_justification: 'Synthetic fixture response.' })
    : prompt.includes('expert auditor for AI reasoning')
    ? JSON.stringify({ clarity: 5, leverage: 5, efficiency: 5, alignment: 5, resilience: 5, overall: 5 })
    : answer;
  const output = url.pathname.endsWith('/responses') ? {
    id: 'resp_fixture_' + providerCalls, object: 'response', created_at: 1,
    status: 'completed', model: body.model ?? 'gpt-4o-mini',
    output: [{ id: 'msg_fixture_' + providerCalls, type: 'message', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: content, annotations: [] }] }],
    output_text: content, usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  } : {
    id: 'chatcmpl_fixture_' + providerCalls, object: 'chat.completion', created: 1,
    model: body.model ?? 'gpt-4o-mini',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  };
  return new Response(JSON.stringify(output), { status: 200, headers: { 'content-type': 'application/json' } });
};

async function executeSwift(configuration: Record<string, unknown>): Promise<Record<string, unknown>> {
  const binary = process.env.IOS_DEVICE_E2E_SWIFT_BINARY!;
  const args = JSON.parse(process.env.IOS_DEVICE_E2E_SWIFT_ARGS ?? '[]') as unknown;
  if (!Array.isArray(args) || args.length > 20 || args.some(value => typeof value !== 'string' || value.length > 2048)) {
    throw new Error('Invalid bounded Swift fixture arguments.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(binary, [...args, '--execute', '--allow-loopback'], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'LD_LIBRARY_PATH'].includes(key))) });
    let stdout = '';
    let stderrBytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 60_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (Buffer.byteLength(stdout) > 64_000) child.kill();
    });
    child.stderr.on('data', (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > 64_000) child.kill(); });
    child.stdin.on('error', () => { child.kill(); });
    child.on('error', () => { clearTimeout(timer); reject(new Error('Swift fixture failed to launch.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut || Buffer.byteLength(stdout) > 64_000 || stderrBytes > 64_000) {
        reject(new Error('Swift fixture failed; no private process output was reflected.'));
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        if (parsed.version !== 'ios-device-e2e/v1' || !Array.isArray(parsed.assertions)
          || parsed.assertions.some(value => !swiftAssertionNames.includes(String(value)))
          || parsed.transport !== 'urlsession-loopback-http-test-adapter'
          || parsed.credentialStorage !== 'in-memory-fixture'
          || parsed.liveProvider !== false || parsed.physicalDevice !== false
          || typeof parsed.ok !== 'boolean'
          || parsed.runId !== configuration.runId || parsed.sourceSha !== configuration.sourceSha
          || !Number.isInteger(parsed.requestsMade) || Number(parsed.requestsMade) < 0 || Number(parsed.requestsMade) > 200
          || !Number.isInteger(parsed.responseBytes) || Number(parsed.responseBytes) < 0 || Number(parsed.responseBytes) > 4_194_304
          || (parsed.failure !== undefined && parsed.failure !== null && !/^[A-Z_]{1,80}$/u.test(String(parsed.failure)))
          || /ag[dp]1\./u.test(stdout)) throw new Error('Invalid Swift report.');
        resolve({ version: parsed.version, ok: parsed.ok, runId: parsed.runId, sourceSha: parsed.sourceSha,
          transport: parsed.transport, credentialStorage: parsed.credentialStorage,
          liveProvider: parsed.liveProvider, physicalDevice: parsed.physicalDevice,
          assertions: parsed.assertions, requestsMade: parsed.requestsMade, responseBytes: parsed.responseBytes,
          ...(parsed.failure ? { failure: parsed.failure } : {}), processSucceeded: code === 0 });
      }
      catch { reject(new Error('Swift fixture did not return a bounded JSON report.')); }
    });
    child.stdin.end(JSON.stringify(configuration));
  });
}

run('Swift client through real device Gateway and PostgreSQL', () => {
  beforeAll(async () => {
    const connection = validateDatabaseUrl(process.env.IOS_DEVICE_E2E_DATABASE_URL ?? '');
    const binary = process.env.IOS_DEVICE_E2E_SWIFT_BINARY ?? '';
    if (!path.isAbsolute(binary) || !existsSync(binary)) throw new Error('An existing absolute Swift fixture binary is required.');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(process.env.IOS_DEVICE_E2E_RUN_ID ?? '')
      || !/^[0-9a-f]{40}$/u.test(process.env.IOS_DEVICE_E2E_SOURCE_SHA ?? '')
      || !path.isAbsolute(process.env.IOS_DEVICE_E2E_REPORT_PATH ?? '')) throw new Error('Bound report configuration is required.');
    memoryDirectory = mkdtempSync(path.join(tmpdir(), 'arcanos-ios-e2e-memory-'));
    Object.assign(process.env, {
      ARCANOS_GPT_ACCESS_TOKEN: operatorToken, ARCANOS_GPT_ACCESS_PRINCIPAL_ID: 'operator:ios-e2e',
      ARCANOS_GPT_ACCESS_WORKSPACE_ID: 'ios-e2e', ARCANOS_GPT_ACCESS_DEVICE_ORIGIN: origin,
      ARCANOS_GPT_ACCESS_SCOPES: 'jobs.create,jobs.result,capabilities.read,capabilities.run',
      MCP_ALLOW_MODULE_ACTIONS: 'ARCANOS:LOCAL_AGENT:git.status,ARCANOS:LOCAL_AGENT:tests.run',
      ARCANOS_LOCAL_AGENT_EXECUTOR_TOKEN: executorToken, ARCANOS_LOCAL_AGENT_EXECUTOR_PRINCIPAL_ID: 'executor:ios-e2e',
      ARCANOS_LOCAL_AGENT_EXECUTOR_INSTANCE_ID: 'ios-e2e-instance', ARCANOS_LOCAL_AGENT_EXECUTOR_DEVICE_ID: executorId,
      ARCANOS_LOCAL_AGENT_WORKSPACES: 'ios-e2e', ARC_MEMORY_PATH: memoryDirectory,
      TRINITY_JUDGED_FEEDBACK_ENABLED: 'false', OPENAI_BASE_URL: 'https://provider-e2e.example.invalid/v1',
      OPENAI_API_KEY: 'sk-isolated-ios-e2e-provider-placeholder-not-a-real-key',
    });
    globalThis.fetch = providerFetch;
    jest.unstable_mockModule('dotenv', () => ({
      default: { config: () => ({ parsed: {} }) }, config: () => ({ parsed: {} }),
    }));
    // The final executor is a fixture, including its authoritative registration.
    // Requester authorization, action validation and job persistence stay real.
    jest.unstable_mockModule('@prisma/client', () => ({
      Prisma: {},
      PrismaClient: class {
        agent = { findUnique: async ({ where }: { where: { id: string } }) => where.id === executorId ? {
          id: executorId, role: 'executor', capabilities: ['git.status', 'tests.run'], status: 'idle', lastHeartbeat: new Date(Date.now() - 1_000),
        } : null };
      },
    }));
    admin = new Pool({ connectionString: connection, max: 2 });
    const version = await admin.query("SELECT current_setting('server_version_num')::int AS version");
    expect(version.rows[0].version).toBeGreaterThanOrEqual(180000);
    await admin.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const scopedURL = new URL(connection);
    scopedURL.searchParams.set('options', `-csearch_path=${schema}`);
    process.env.DATABASE_URL = scopedURL.toString();
    db = await import('../../src/core/db/client.js');
    expect(await db.initializeDatabase()).toBe(true);
    const pool = db.getPool()!;
    const { TABLE_DEFINITIONS } = await import('../../src/core/db/schema.js');
    for (const table of ['job_data', 'job_events', 'execution_logs']) {
      const definition = TABLE_DEFINITIONS.find(value => value.startsWith(`CREATE TABLE IF NOT EXISTS ${table} (`));
      if (!definition) throw new Error('Canonical fixture table definition missing.');
      await pool.query(definition);
    }
    for (const definition of TABLE_DEFINITIONS.filter(value => /^ALTER TABLE job_events\s+ADD COLUMN IF NOT EXISTS (stats_worker_id|claim_generation|operation)/u.test(value))) await pool.query(definition);
    await pool.query(readFileSync('migrations/20260911_gpt_access_devices_v1.sql', 'utf8'));
    await pool.query(readFileSync('migrations/20260724_local_agent_job_hardening_v1/01_local_agent_job_idempotency.sql', 'utf8'));
    const { getOpenAIAdapter } = await import('../../src/core/adapters/openai.adapter.js');
    getOpenAIAdapter({ apiKey: process.env.OPENAI_API_KEY!, baseURL: process.env.OPENAI_BASE_URL,
      maxRetries: 0, timeout: 2000, fetch: providerFetch });
    const { initializeModuleRegistry } = await import('../../src/services/moduleRegistry.js');
    await initializeModuleRegistry();
    const { configureDefaultArcanosCoreRuntimeProviders } = await import('../../src/services/arcanosCoreRuntimeProviders.js');
    configureDefaultArcanosCoreRuntimeProviders();
    const { configureLocalAgentActionExecutor } = await import('../../src/services/localAgent/executor.js');
    const { executeLocalAgentActionAsJob } = await import('../../src/services/localAgent/service.js');
    configureLocalAgentActionExecutor(executeLocalAgentActionAsJob);
    const { default: router } = await import('../../src/routes/gpt-access.js');
    const { gptAccessDeviceHttpBoundary } = await import('../../src/services/gptAccessDeviceHttpBoundary.js');
    app = express();
    app.use('/gpt-access/devices', gptAccessDeviceHttpBoundary);
    app.use(express.json({ limit: '64kb' }));
    app.use((req, res, next) => {
      const json = res.json.bind(res);
      res.json = ((body: Record<string, unknown>) => {
        if (req.path === '/gpt-access/jobs/result' && body.status === 'not_found') deniedPeerReads += 1;
        return json(body);
      }) as typeof res.json;
      next();
    });
    app.use(router);
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Loopback server did not bind.');
    baseURL = `http://127.0.0.1:${address.port}`;
    const pair = async () => {
      const result = await request(app).post('/gpt-access/devices/pairing')
        .set('Authorization', `Bearer ${operatorToken}`).send({ capabilityActions: ['git.status', 'tests.run'] });
      expect(result.status).toBe(201);
      secrets.push(result.body.pairingToken);
      return String(result.body.pairingToken);
    };
    pairingA = await pair(); pairingB = await pair();
    jobs = await import('../../src/core/db/repositories/jobRepository.js');
    localJobs = await import('../../src/core/db/repositories/localAgentJobRepository.js');
    signalListeners = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    worker = await import('../../src/workers/jobRunner.js');
    draining = (async () => {
      const deadline = Date.now() + 60_000;
      while (!stop && Date.now() < deadline) {
        const job = await jobs.claimNextPendingJob({ workerId: 'ios-e2e-worker', leaseMs: 60_000, priorityQueueEnabled: false });
        if (job) {
          if (++aiExecutions > 1 || job.job_type !== 'gpt') throw new Error('Unexpected fixture worker assignment.');
          const outcome = await worker.executeQueuedGptRequest({ jobId: job.id, rawInput: job.input, startedAt: job.started_at });
          const terminal = await jobs.updateClaimedJobTerminal(job.id, outcome.status, {
            fence: jobs.createClaimedJobFence('ios-e2e-worker', job.claim_generation),
            output: outcome.output, errorMessage: outcome.errorMessage,
          });
          if (!terminal || terminal.status !== 'completed') throw new Error('Fixture AI worker did not complete.');
        }
        const local = await localJobs.claimLocalAgentJob({ deviceId: executorId, claimKeyHash: 'f'.repeat(64),
          leaseMs: 60_000, deviceScopes: ['git.status', 'tests.run'] });
        if (local?.disposition === 'CLAIMED') {
          if (++executorExecutions > 1) throw new Error('Unexpected repeated executor assignment.');
          const assignment = localJobs.readLocalAgentJobEnvelope(local.job)!.job;
          const output = { profile: 'typescript-unit', status: 'passed', exitCode: 0,
            stdout: 'Synthetic executor fixture completed.', stderr: '', durationMs: 1, truncated: false };
          const { validateLocalAgentActionOutput } = await import('../../src/services/localAgent/contracts.js');
          validateLocalAgentActionOutput('tests.run', output);
          await localJobs.submitLocalAgentJobResult({ jobId: local.job.id, deviceId: executorId,
            resultKeyHash: 'e'.repeat(64), resultFingerprintHash: 'd'.repeat(64), outcome: 'succeeded', output,
            metrics: { durationMs: 1, outputTruncated: false },
            correlation: { traceId: assignment.traceId, requestId: assignment.requestId, deviceId: executorId } });
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    })().catch(error => { drainError = error; });
  }, 60_000);

  test('executes the Swift device flow and independently verifies durable ownership and terminal states', async () => {
    swiftReport = await executeSwift({ version: 'ios-device-e2e/v1', baseURL, origin, pairingTokenA: pairingA,
      pairingTokenB: pairingB, expectedAIAnswer: answer, runId: process.env.IOS_DEVICE_E2E_RUN_ID,
      sourceSha: process.env.IOS_DEVICE_E2E_SOURCE_SHA });
    stop = true;
    await draining;
    if (drainError) throw drainError;
    check('swift_client_flow', swiftReport.ok === true && swiftReport.processSucceeded === true
      && swiftReport.runId === process.env.IOS_DEVICE_E2E_RUN_ID
      && swiftReport.sourceSha === process.env.IOS_DEVICE_E2E_SOURCE_SHA
      && JSON.stringify(swiftReport.assertions) === JSON.stringify(swiftAssertionNames));
    const pool = db.getPool()!;
    const devices = (await pool.query('SELECT * FROM gpt_access_devices')).rows;
    const pairings = (await pool.query('SELECT * FROM gpt_access_device_pairings')).rows;
    const rows = (await pool.query('SELECT * FROM job_data ORDER BY created_at')).rows;
    const ai = rows.find(row => row.job_type === 'gpt');
    const local = rows.find(row => row.job_type === 'local-agent');
    const serialized = JSON.stringify({ devices, pairings });
    check('pairing_persisted_hashed_only', devices.length === 2 && pairings.length === 2
      && pairings.every(row => row.consumed_at !== null) && !/ag[dp]1\./u.test(serialized)
      && devices.every(row => /^[0-9a-f]{64}$/u.test(row.credential_hash)));
    check('ai_job_persisted_with_device_owner', Boolean(ai && ai.input.gptAccessDeviceOwner?.version === 1
      && devices.some(device => device.device_id === ai.input.gptAccessDeviceOwner.deviceId)));
    check('ai_worker_claim_executed_and_fenced', aiExecutions === 1 && ai?.status === 'completed'
      && ai.claim_generation === '1' && ai.last_worker_id === 'ios-e2e-worker'
      && JSON.stringify(ai.output).includes(answer));
    check('provider_fixture_called', providerCalls > 0 && providerCalls <= 20);
    check('local_agent_confirmation_single_enqueue', rows.length === 2 && local?.input.job.authorization.decision === 'confirmed');
    check('local_agent_executor_result_persisted', executorExecutions === 1 && local?.status === 'completed'
      && local.worker_id === executorId && local.input.gptAccessDeviceOwner.deviceId === ai.input.gptAccessDeviceOwner.deviceId);
    check('device_rotation_and_revocation_persisted', devices.filter(device => device.revoked_at !== null).length === 1
      && devices.some(device => device.revoked_at !== null && device.issued_at > device.paired_at));
    check('cross_device_job_reads_denied', deniedPeerReads >= 1);
    check('secret_free_report', secrets.every(secret => !JSON.stringify(swiftReport).includes(secret))
      && !/ag[dp]1\.[A-Za-z0-9_-]{43}/u.test(JSON.stringify(swiftReport)));
    completed = true;
  }, 65_000);

  test('isolates an explicit Local Agent idempotency key between requester devices in PostgreSQL', async () => {
    const { executeLocalAgentActionAsJob } = await import('../../src/services/localAgent/service.js');
    const context = { source: 'gpt-access' as const, principalId: 'operator:ios-e2e', workspaceId: 'ios-e2e',
      actorKey: 'fixture-owner', requestId: 'fixture-same-key', traceId: 'fixture-same-key', idempotencyKey: 'same-device-independent-key' };
    const first = await executeLocalAgentActionAsJob({ action: 'git.status', payload: {},
      context: { ...context, requesterDeviceId: 'aa000000-0000-4000-8000-000000000001' } }) as Record<string, unknown>;
    const second = await executeLocalAgentActionAsJob({ action: 'git.status', payload: {},
      context: { ...context, requesterDeviceId: 'aa000000-0000-4000-8000-000000000002' } }) as Record<string, unknown>;
    const replay = await executeLocalAgentActionAsJob({ action: 'git.status', payload: {},
      context: { ...context, requesterDeviceId: 'aa000000-0000-4000-8000-000000000001' } }) as Record<string, unknown>;
    check('local_agent_device_idempotency_isolated', first.accepted === true && second.accepted === true && first.jobId !== second.jobId
      && replay.accepted === true && replay.deduped === true && replay.jobId === first.jobId);
  });

  afterAll(async () => {
    let cleanupFailed = false;
    const attempt = async (operation: () => Promise<void> | void) => {
      try { await operation(); } catch { cleanupFailed = true; }
    };
    stop = true;
    await attempt(async () => { await draining; });
    globalThis.fetch = rawFetch;
    await attempt(async () => {
      if (!server) return;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    });
    serverClosed = !server || !server.listening;
    await attempt(async () => { if (db) await db.close(); });
    await attempt(async () => {
      if (!admin || !schemaCreated) return;
      if (!/^ios_device_e2e_[0-9a-f]{32}$/u.test(schema)) throw new Error('Invalid owned schema cleanup target.');
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      schemaRemoved = (await admin.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema])).rows.length === 0;
    });
    await attempt(async () => { await admin?.end(); });
    await attempt(() => {
      if (!memoryDirectory) return;
      if (path.dirname(memoryDirectory) !== path.resolve(tmpdir()) || !path.basename(memoryDirectory).startsWith('arcanos-ios-e2e-memory-')) throw new Error('Invalid memory cleanup target.');
      rmSync(memoryDirectory, { recursive: true, force: true });
    });
    if (signalListeners) for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      for (const listener of process.listeners(signal)) if (!signalListeners[signal].includes(listener)) process.removeListener(signal, listener);
    }
    const reportPath = process.env.IOS_DEVICE_E2E_REPORT_PATH;
    if (reportPath && path.isAbsolute(reportPath)) writeFileSync(reportPath, JSON.stringify({
      proof: 'ios-device-e2e/v1', runId: process.env.IOS_DEVICE_E2E_RUN_ID, sourceSha: process.env.IOS_DEVICE_E2E_SOURCE_SHA,
      passed: completed && !cleanupFailed && schemaRemoved && serverClosed && [...assertions.values()].every(Boolean),
      transport: 'urlsession-loopback-http-test-adapter', assertions: [...assertions].map(([name, passed]) => ({ name, passed })),
      schemaRemoved, serverClosed, synthetic: ['Keychain item storage', 'provider response', 'Local Agent executor'],
      sql: { aiExecutions, executorExecutions, providerCalls, deniedPeerReads }, swift: swiftReport,
    }, null, 2));
    if (cleanupFailed) throw new Error('Isolated fixture cleanup could not be fully verified.');
  }, 30_000);
});
