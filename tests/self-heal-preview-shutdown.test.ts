import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PreviewShutdownJournal, type ShutdownPgClient } from '../src/services/selfImprove/selfHealingPreviewShutdown.js';

const owner = () => ({ version: 1, owner: 'pbjustin', profile: 'worker-coordinator-v1', repository: 'pbjustin/Arcanos',
  runId: 'shutdown-test-1544', sourceSha: 'a'.repeat(40), compiledSha256: 'b'.repeat(64), expiresAt: new Date(Date.now() + 60_000).toISOString() });
const binding = { scenario: 'A06' as const, processInstanceId: '11111111-1111-4111-8111-111111111111',
  deploymentId: '22222222-2222-4222-8222-222222222222', pid: 1544, redisClientId: '41' };
function transport(activeOwner = owner()) {
  const events: Array<{ phase: string; at: string; data: Record<string, unknown> }> = [];
  let blocked = true;
  let foreignOwner = false;
  let duplicate = false;
  const client: ShutdownPgClient = {
    connect: jest.fn(async () => undefined), end: jest.fn(async () => undefined),
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      if (sql.startsWith('SELECT identity')) return { rows: [{ identity: JSON.stringify(foreignOwner ? { ...activeOwner, runId: 'foreign-test-run' } : activeOwner) }] };
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('INSERT INTO')) { if (duplicate) throw new Error('test duplicate'); duplicate = true; return { rows: [{ process_instance_id: binding.processInstanceId }] }; }
      if (sql.startsWith('UPDATE')) {
        expect(sql).toContain('identity=$9'); expect(values[8]).toBe(JSON.stringify(activeOwner));
        if (foreignOwner) return { rows: [] };
        if (events.some(event => event.phase === values[0])) return { rows: [] };
        events.push({ phase: String(values[0]), at: new Date().toISOString(), data: JSON.parse(String(values[1])) });
        return { rows: [{ process_instance_id: binding.processInstanceId }] };
      }
      if (sql.startsWith('SELECT scenario')) return { rows: foreignOwner ? [] : [{ scenario: binding.scenario, source_sha: activeOwner.sourceSha,
        process_instance_id: binding.processInstanceId, deployment_id: binding.deploymentId, pid: binding.pid, redis_client_id: binding.redisClientId, events }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: !blocked }] };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] };
      throw new Error('Unexpected test shutdown SQL');
    }),
  };
  return { client, events, owner: activeOwner, release: () => { blocked = false; }, foreign: () => { foreignOwner = true; } };
}
afterEach(() => { jest.useRealTimers(); });
describe('bounded shutdown journal and independent advisory barrier', () => {
  it('rejects foreign ownership before any DDL or receipt mutation and bounds PostgreSQL operations', async () => {
    const fixture = transport(); fixture.foreign(); const construct = jest.fn(() => fixture.client);
    await expect(PreviewShutdownJournal.open({}, fixture.owner, construct)).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(construct).toHaveBeenCalledWith(expect.objectContaining({ query_timeout: 250, connectionTimeoutMillis: 1000,
      options: '-c statement_timeout=250 -c lock_timeout=100' }));
    expect(fixture.client.query).toHaveBeenCalledTimes(1); expect(fixture.client.end).toHaveBeenCalledTimes(1);
  });
  it.each(['timeout', 'false'] as const)('retains acquired probe ownership after an unlock %s and retries release on close', async failure => {
    const fixture = transport(); const originalQuery = fixture.client.query;
    let heldLocks = 0; let acquisitions = 0; let unlocks = 0;
    fixture.client.query = async (sql, values) => {
      if (sql.includes('pg_try_advisory_lock')) { acquisitions += 1; heldLocks += 1; return { rows: [{ acquired: true }] }; }
      if (sql.includes('pg_advisory_unlock')) {
        unlocks += 1;
        if (unlocks === 1) {
          if (failure === 'timeout') throw new Error('Synthetic advisory unlock query timeout.');
          return { rows: [{ released: false }] };
        }
        heldLocks -= 1; return { rows: [{ released: true }] };
      }
      return originalQuery(sql, values);
    };
    const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    try {
      await expect(journal.barrierAvailable()).rejects.toThrow(failure === 'timeout'
        ? 'Synthetic advisory unlock query timeout.' : 'SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
      expect(heldLocks).toBe(1);
      await expect(journal.barrierAvailable()).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
      await expect(journal.holdBarrier()).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
      expect(acquisitions).toBe(1);
    } finally { await journal.close(); }
    expect(unlocks).toBe(2);
    expect(heldLocks).toBe(0);
    expect(fixture.client.end).toHaveBeenCalledTimes(1);
  });
  it('does not acquire ownership or unlock a barrier still held by another session', async () => {
    const fixture = transport(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    expect(await journal.barrierAvailable()).toBe(false);
    await journal.close();
    expect((fixture.client.query as ReturnType<typeof jest.fn>).mock.calls.filter(([sql]) => String(sql).includes('pg_advisory_unlock'))).toEqual([]);
    expect(fixture.client.end).toHaveBeenCalledTimes(1);
  });
  it('keeps the actual evaluation pending across abort until independent release, then records the cancellation', async () => {
    jest.useFakeTimers(); const fixture = transport(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding); const abort = new AbortController();
    let finished = false;
    const held = journal.waitForShutdownRelease(abort.signal).then(() => { finished = true; });
    await jest.advanceTimersByTimeAsync(25); abort.abort(); await jest.advanceTimersByTimeAsync(50);
    expect(finished).toBe(false);
    expect(fixture.events.map(event => event.phase)).toEqual(['prepared', 'evaluation_held', 'shutdown_seen']);
    fixture.release(); await jest.advanceTimersByTimeAsync(25); await held;
    expect(finished).toBe(true); expect(fixture.events.at(-1)).toMatchObject({ phase: 'barrier_released', data: { signalSeen: true } });
    await journal.close(); expect(fixture.client.end).toHaveBeenCalledTimes(1);
  });
  it('expires the injected hold within five seconds even if the helper disappears without release', async () => {
    jest.useFakeTimers(); const fixture = transport(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding); const held = journal.waitForShutdownRelease();
    await jest.advanceTimersByTimeAsync(5000); await held;
    expect(fixture.events.at(-1)).toMatchObject({ phase: 'barrier_expired' });
    expect(Number(fixture.events.at(-1)?.data.elapsedMs)).toBeLessThanOrEqual(5000);
    expect(fixture.events.some(event => event.phase === 'coordinator_drained')).toBe(false);
    await journal.close();
  });
  it('keeps the five-second overall bound with 249ms PostgreSQL round trips and an abort at 4300ms', async () => {
    jest.useFakeTimers(); const fixture = transport();
    const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding);
    const originalQuery = fixture.client.query;
    fixture.client.query = async (...args) => {
      await new Promise(resolve => setTimeout(resolve, 249));
      return originalQuery(...args);
    };
    const started = Date.now(); const abort = new AbortController(); let settledAt: number | null = null;
    const lateAbort = setTimeout(() => abort.abort(), 4300);
    const held = journal.waitForShutdownRelease(abort.signal).then(() => { settledAt = Date.now(); });
    await jest.advanceTimersByTimeAsync(5000); await held; clearTimeout(lateAbort);
    expect(Number(settledAt) - started).toBeLessThanOrEqual(5000);
    expect(fixture.events.at(-1)?.phase).toBe('barrier_expired');
    expect(fixture.events.some(event => event.phase === 'coordinator_drained')).toBe(false);
    fixture.client.query = originalQuery; await journal.close();
  });
  it('rejects duplicate scenario authority, arbitrary phase/data and unsafe readback without weakening exclusion', async () => {
    const fixture = transport(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding);
    await expect(journal.prepare(binding)).rejects.toThrow('test duplicate');
    await expect(journal.append('arbitrary_phase')).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    await expect(journal.append('coordinator_drained', { secret: 'test-unprojected-shutdown-value' })).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    fixture.events.push({ phase: 'coordinator_drained', at: new Date().toISOString(), data: { secret: 'test-unprojected-shutdown-value' } });
    await expect(journal.read('A06')).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    await journal.close();
  });
  it('rejects an unheld or already released barrier instead of manufacturing overlap', async () => {
    const fixture = transport(); fixture.release(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding);
    await expect(journal.waitForShutdownRelease()).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(fixture.events.map(event => event.phase)).toEqual(['prepared']); await journal.close();
  });
  it('rechecks current ownership on mutation and readback without changing an existing receipt', async () => {
    const fixture = transport(); const journal = await PreviewShutdownJournal.open({}, fixture.owner, () => fixture.client);
    await journal.prepare(binding); const before = structuredClone(fixture.events); fixture.foreign();
    await expect(journal.append('coordinator_drained', { inFlight: false })).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    await expect(journal.read('A06')).rejects.toThrow('SELF_HEAL_PREVIEW_SHUTDOWN_EVIDENCE_FAILED');
    expect(fixture.events).toEqual(before); await journal.close();
  });
});
