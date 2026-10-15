import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { beginSelfHealPreviewStartupProbe, readSelfHealPreviewStartupReceipt, type StartupFailureEvidence } from '../src/services/selfImprove/selfHealingPreviewStartup.js';
import type { ShutdownPgClient } from '../src/services/selfImprove/selfHealingPreviewShutdown.js';

const DEPLOYMENT = '55555555-5555-4555-8555-555555555555';
const INSTANCE = '66666666-6666-4666-8666-666666666666';
const env = { ARCANOS_PROCESS_KIND: 'worker', ARCANOS_SELF_HEAL_PREVIEW_PROFILE: 'worker-coordinator-v1',
  ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'scheduler-failure', RAILWAY_DEPLOYMENT_ID: DEPLOYMENT, PORT: '8080' };
const binding = { processInstanceId: INSTANCE, pid: 1234 };
const outcome = (): StartupFailureEvidence => ({ readinessCommitted: false,
  scheduler: { installationAttempts: 1, installations: 0, installationFailures: 1, callbacks: 0 },
  coordinator: { state: 'FAILED', reasonCode: 'scheduler_start_failed', inFlight: false } });
function fixture() {
  const owner = { owner: 'pbjustin', repository: 'pbjustin/Arcanos', profile: 'worker-coordinator-v1',
    sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64), runId: 'test-startup-run-1544',
    issuedAt: new Date(Date.now() - 60_000).toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString() };
  let row: Record<string, unknown> | null = null; let foreign = false;
  const client: ShutdownPgClient = { connect: jest.fn(async () => undefined), end: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT identity')) return { rows: foreign ? [] : [{ identity: JSON.stringify(owner) }] };
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('INSERT INTO')) {
        if (foreign) return { rows: [] }; if (row) throw new Error('test duplicate startup generation');
        row = { source_sha: values[2], process_instance_id: values[3], deployment_id: values[4], pid: values[5],
          readiness_status_code: 503, readiness_ready: false, readiness_child: 'starting', observed_at: new Date(), finished_at: null, evidence: null };
        return { rows: [{ source_sha: owner.sourceSha }] };
      }
      if (sql.startsWith('UPDATE')) {
        if (foreign || !row || row.finished_at) return { rows: [] };
        row.evidence = JSON.parse(String(values[0])); row.finished_at = new Date(); return { rows: [{ source_sha: owner.sourceSha }] };
      }
      if (sql.startsWith('SELECT source_sha')) return { rows: foreign || !row ? [] : [row] };
      throw new Error('Unexpected startup test SQL');
    }) };
  const createClient = jest.fn(() => client);
  const fetchImpl = jest.fn<typeof fetch>(async () => new Response(JSON.stringify({ ready: false, child: 'starting' }), { status: 503 }));
  return { owner, client, createClient, fetchImpl, options: { createClient, fetchImpl, authority: () => ({ owner, database: {} }) },
    foreign: () => { foreign = true; }, row: () => row as Record<string, unknown> };
}
afterEach(() => jest.useRealTimers());
describe('real launcher startup-readiness receipt boundary', () => {
  it('records a bounded real503 sample before scheduler initialization and reads a projected failed-generation receipt', async () => {
    const f = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options);
    expect(f.fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:8080/readyz', expect.objectContaining({ redirect: 'error', signal: expect.any(AbortSignal) }));
    await probe.finish(outcome());
    const read = await readSelfHealPreviewStartupReceipt({}, f.owner, f.options);
    expect(read).toMatchObject({ evidence: 'independent_postgres_startup_readback', receipt: { scenario: 'A04',
      processInstanceId: INSTANCE, deploymentId: DEPLOYMENT, initialReadiness: { statusCode: 503, ready: false, child: 'starting' }, outcome: outcome() } });
    expect(f.createClient).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 500, connectionTimeoutMillis: 1000,
      options: '-c statement_timeout=500 -c lock_timeout=100' }));
    expect(f.client.end).toHaveBeenCalledTimes(2);
  });
  it.each([{ ARCANOS_PROCESS_KIND: 'web' }, { ARCANOS_SELF_HEAL_PREVIEW_PROFILE: '' },
    { ARCANOS_SELF_HEAL_PREVIEW_STARTUP_MODE: 'normal' }, { PORT: 'https://example.invalid' }, { PORT: '8791' },
    { RAILWAY_DEPLOYMENT_ID: 'caller-selected-service' }])('rejects non-approved startup inputs before effects: %j', async patch => {
    const f = fixture(); await expect(beginSelfHealPreviewStartupProbe({ ...env, ...patch }, binding, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    expect(f.client.connect).not.toHaveBeenCalled(); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it.each([{ status: 200, body: { ready: true, child: 'running' } },
    { status: 503, body: { ready: false, child: 'draining' } },
    { status: 503, body: { ready: true, child: 'starting' } }])('does not turn another readiness state into startup proof: %j', async response => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response(JSON.stringify(response.body), { status: response.status }));
    await expect(beginSelfHealPreviewStartupProbe(env, binding, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    expect(f.client.query).toHaveBeenCalledTimes(1); expect(f.client.end).toHaveBeenCalledTimes(1);
  });
  it('bounds the health body and closes the client without DDL on malformed or oversized input', async () => {
    for (const body of ['not-json', 'x'.repeat(4097)]) {
      const f = fixture(); f.fetchImpl.mockImplementation(async () => new Response(body, { status: 503 }));
      await expect(beginSelfHealPreviewStartupProbe(env, binding, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
      expect(f.client.query).toHaveBeenCalledTimes(1); expect(f.client.end).toHaveBeenCalledTimes(1);
    }
  });
  it('does not create a receipt or probe a process under foreign ownership', async () => {
    const f = fixture(); f.foreign();
    await expect(beginSelfHealPreviewStartupProbe(env, binding, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    expect(f.client.query).toHaveBeenCalledTimes(1); expect(f.fetchImpl).not.toHaveBeenCalled();
  });
  it('atomically refuses owner changes during insert and finish instead of adopting the new identity', async () => {
    const f = fixture(); f.fetchImpl.mockImplementation(async () => { f.foreign(); return new Response('{"ready":false,"child":"starting"}', { status: 503 }); });
    await expect(beginSelfHealPreviewStartupProbe(env, binding, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    expect(f.row()).toBeNull();
    const other = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, other.options); other.foreign();
    await expect(probe.finish(outcome())).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_'); expect(other.row().finished_at).toBeNull();
    expect(other.client.end).toHaveBeenCalledTimes(1);
  });
  it('never overwrites another failed generation or a completed outcome', async () => {
    const f = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options); await probe.finish(outcome());
    await expect(probe.finish(outcome())).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    await expect(beginSelfHealPreviewStartupProbe(env, { ...binding, pid: 1235 }, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
    expect(f.row().pid).toBe(1234);
  });
  it('retains premature readiness as a failure observation instead of erasing it during close', async () => {
    const f = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options);
    await probe.finish({ ...outcome(), readinessCommitted: true });
    const result = await readSelfHealPreviewStartupReceipt({}, f.owner, f.options);
    expect(result.receipt.outcome.readinessCommitted).toBe(true);
  });
  it('contains idle PostgreSQL connection loss without raw errors or an invented completed receipt', async () => {
    const f = fixture(); let onError: ((error: Error) => void) | undefined;
    f.client.on = (_event, listener) => { onError = listener; };
    const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options);
    onError?.(new Error('test-sensitive-connection-diagnostic'));
    await expect(probe.finish(outcome())).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_EVIDENCE_FAILED');
    expect(f.row().finished_at).toBeNull(); expect(f.client.end).toHaveBeenCalledTimes(1);
  });
  it('projects away unrelated fields from persisted diagnostics before returning them', async () => {
    const f = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options); await probe.finish(outcome());
    (f.row().evidence as Record<string, unknown>).unrelated = 'test-sensitive-unknown-diagnostic';
    expect(JSON.stringify(await readSelfHealPreviewStartupReceipt({}, f.owner, f.options))).not.toContain('test-sensitive-unknown-diagnostic');
  });
  it('never treats an unfinished or expired generation as a completed failure receipt', async () => {
    const f = fixture(); const probe = await beginSelfHealPreviewStartupProbe(env, binding, f.options);
    await expect(readSelfHealPreviewStartupReceipt({}, f.owner, f.options)).rejects.toThrow();
    await probe.finish(outcome()); jest.useFakeTimers(); jest.setSystemTime(Date.parse(f.owner.expiresAt));
    await expect(readSelfHealPreviewStartupReceipt({}, f.owner, f.options)).rejects.toThrow('SELF_HEAL_PREVIEW_STARTUP_');
  });
});
