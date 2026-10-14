import { mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  attestSelfHealPreviewCleanupTarget, parseSelfHealPreviewCleanupArgs,
  readSelfHealPreviewCleanupReceipt, runSelfHealPreviewCleanup,
  validateSelfHealPreviewCleanupReceipt,
} from '../scripts/self-heal-preview-cleanup.mjs';

const NOW = Date.parse('2026-10-14T16:00:00.000Z');
const ID = { project: '11111111-1111-4111-8111-111111111111', environment: '22222222-2222-4222-8222-222222222222',
  web: '33333333-3333-4333-8333-333333333333', worker: '44444444-4444-4444-8444-444444444444',
  postgres: '55555555-5555-4555-8555-555555555555', redis: '66666666-6666-4666-8666-666666666666',
  pgVolume: '77777777-7777-4777-8777-777777777777', redisVolume: '88888888-8888-4888-8888-888888888888' };
function receipt(patch = {}) { return {
  version: 1, owner: 'pbjustin', repository: 'pbjustin/Arcanos', prNumber: 1544,
  sourceSha: 'a'.repeat(40), runId: 'self-heal-run-1544', projectId: ID.project,
  projectName: 'arc-pr1544-heavy-test', workspaceId: '1c9265a3-986f-4304-ad3e-5a874caab039',
  environmentId: ID.environment, environmentName: 'backstage-heavy-pr-1544-e2e',
  issuedAt: '2026-10-14T15:59:00.000Z', expiresAt: '2026-10-14T17:00:00.000Z', ...patch,
}; }
function connection(nodes) { return { edges: nodes.map(node => ({ node })) }; }
function status(partial = false) {
  return {
    id: ID.project, name: receipt().projectName, workspaceId: receipt().workspaceId, deletedAt: null, buckets: [],
    services: connection(partial ? [] : [
      { id: ID.web, name: 'arcanos-web-pr1544-heavy' }, { id: ID.worker, name: 'arcanos-worker-pr1544-heavy' },
      { id: ID.postgres, name: 'Postgres' }, { id: ID.redis, name: 'Redis' },
    ]), environments: connection([{
      id: ID.environment, name: receipt().environmentName, deletedAt: null,
      serviceInstances: connection(partial ? [] : [ID.web, ID.worker, ID.postgres, ID.redis].map(serviceId => ({ serviceId }))),
      volumeInstances: connection(partial ? [] : [
        { id: ID.pgVolume, serviceId: ID.postgres, mountPath: '/var/lib/postgresql/data' },
        { id: ID.redisVolume, serviceId: ID.redis, mountPath: '/data' },
      ]),
    }]),
  };
}
function harness(options = {}) {
  let clockMs = options.now ?? NOW; let statuses = 0; let lists = 0;
  const events = [];
  const command = jest.fn(async (_file, args) => {
    const commandName = args[0];
    if (options.commandError) throw new Error(options.commandError);
    if (commandName === 'status') {
      const payload = options.status?.(++statuses) ?? status();
      return { stdout: JSON.stringify(payload), stderr: '' };
    }
    if (commandName === 'delete') return { stdout: JSON.stringify({ scheduled: true }), stderr: '' };
    if (commandName === 'list') return { stdout: JSON.stringify(options.list?.(++lists) ?? []), stderr: '' };
    throw new Error(`UNEXPECTED_COMMAND_${commandName}`);
  });
  const sleep = jest.fn(async ms => { if (!options.stalledClock) clockMs += ms; });
  return { command, sleep, events, now: () => clockMs,
    env: { PATH: '/fixture/bin', RAILWAY_TOKEN: 'fixture-management-secret', OPENAI_API_KEY: 'mock-must-be-stripped' },
    invocation: { executable: 'railway-fixture', argsPrefix: [] }, onReceipt: event => events.push(event) };
}
const execute = value => ({ receipt: value ?? receipt(), execute: true, allowDeleteOwnedProject: true });
const tempFiles = [];
function temporaryReceipt(value) {
  const directory = mkdtempSync(join(tmpdir(), 'arcanos-self-heal-cleanup-'));
  const path = join(directory, 'ownership.json'); writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  tempFiles.push({ path, directory }); return path;
}
afterEach(() => {
  for (const { path, directory } of tempFiles.splice(0)) { unlinkSync(path); rmdirSync(directory); }
});

describe('receipt-bound self-heal preview cleanup and fixed-expiry watchdog', () => {
  it('dry-runs valid ownership with zero CLI or timer activity', async () => {
    const h = harness();
    await expect(runSelfHealPreviewCleanup({ receipt: receipt(), execute: false, allowDeleteOwnedProject: false }, h))
      .resolves.toMatchObject({ status: 'DRY_RUN', executed: false, deletionRequested: false, absenceVerified: false });
    expect(h.command).not.toHaveBeenCalled(); expect(h.sleep).not.toHaveBeenCalled();
  });
  it.each([
    { owner: 'other' }, { repository: 'other/repo' }, { prNumber: 1527 }, { sourceSha: 'A'.repeat(40) },
    { runId: '../escape' }, { projectName: 'Arcanos' }, { projectName: 'Arcanos Live PR 1527' },
    { environmentName: 'production' }, { workspaceId: ID.web }, { RAILWAY_TOKEN: 'forbidden-extra' },
    { issuedAt: '2026-10-14T16:01:00.000Z' }, { expiresAt: '2026-10-14T18:00:00.000Z' },
    { expiresAt: '2026-10-14T17:00:00Z' },
  ])('refuses invalid receipt %# before network or deletion', async patch => {
    const h = harness(); await expect(runSelfHealPreviewCleanup(execute(receipt(patch)), h)).rejects.toThrow(/^SELF_HEAL_PREVIEW_CLEANUP_/u);
    expect(h.command).not.toHaveBeenCalled();
  });
  it.each([
    '7faf44e5-519c-4e73-8d7a-da9f389e6187', '8e4cb1eb-1441-4e83-b434-15c06c676a5f',
    'fb583147-6c39-4343-9267-500f357d25ab', '1765befb-b805-4051-9af9-28634e986886',
    'c4ade025-3f13-4fca-9309-5d0dd81396fe', '6647b5b1-d796-4783-b5f0-b8e356019ca6',
    '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
  ])('rejects protected canonical identity %s even with forged preview names', async projectId => {
    const h = harness(); await expect(runSelfHealPreviewCleanup(execute(receipt({ projectId })), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RECEIPT_INVALID');
    expect(h.command).not.toHaveBeenCalled();
  });
  it.each([
    { execute: true, allowDeleteOwnedProject: false }, { execute: false, allowDeleteOwnedProject: true },
    { execute: false, allowDeleteOwnedProject: false, watchdog: true },
    { execute: 'true', allowDeleteOwnedProject: 'true' },
  ])('requires exact dual deletion authorization %#', async flags => {
    const h = harness(); await expect(runSelfHealPreviewCleanup({ receipt: receipt(), ...flags }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_AUTHORIZATION_REQUIRED');
    expect(h.command).not.toHaveBeenCalled();
  });
  it('deletes only an exact twice-attested project and verifies independent list absence', async () => {
    const h = harness({ list: attempt => attempt === 1 ? [{ id: ID.project, name: 'pending' }] : [] });
    const result = await runSelfHealPreviewCleanup(execute(), h);
    expect(result).toMatchObject({ status: 'DELETED', executed: true, deletionRequested: true, absenceVerified: true, serviceCount: 4, volumeCount: 2 });
    expect(h.command.mock.calls.map(call => call[1])).toEqual([
      ['status', '--project', ID.project, '--environment', ID.environment, '--json'],
      ['status', '--project', ID.project, '--environment', ID.environment, '--json'],
      ['delete', '--project', ID.project, '--yes', '--json'], ['list', '--json'], ['list', '--json'],
    ]);
    for (const [file, , options] of h.command.mock.calls) {
      expect(file).toBe('railway-fixture'); expect(options).toMatchObject({ windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      expect(options.timeout).toBeLessThanOrEqual(15_000); expect(options.env.RAILWAY_TOKEN).toBe('fixture-management-secret');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    }
    expect(JSON.stringify(h.events)).not.toContain('fixture-management-secret');
  });
  it('allows cleanup after source head changes and receipt expiry without adopting another target', async () => {
    const h = harness({ now: NOW + 3 * 60 * 60 * 1000, status: () => {
      const payload = status(); payload.environments.edges[0].node.serviceInstances.edges[0].node.latestDeployment = { meta: { commitHash: 'd'.repeat(40) } }; return payload;
    } });
    expect(validateSelfHealPreviewCleanupReceipt(receipt(), { now: h.now }).sourceSha).toBe('a'.repeat(40));
    expect((await runSelfHealPreviewCleanup(execute(), h)).status).toBe('DELETED');
    expect(h.command.mock.calls.every(call => !call[1].includes('deploy'))).toBe(true);
  });
  it('attests empty or partial owned provisioning without requiring four completed services', () => {
    expect(attestSelfHealPreviewCleanupTarget(status(true), receipt())).toEqual({ serviceCount: 0, volumeCount: 0, environmentCount: 1 });
    const partial = status(true); partial.services.edges.push({ node: { id: ID.redis, name: 'Redis' } });
    expect(attestSelfHealPreviewCleanupTarget(partial, receipt()).serviceCount).toBe(1);
  });
  it.each([
    payload => { payload.id = ID.web; }, payload => { payload.name = 'Arcanos Live PR 1527'; },
    payload => { payload.workspaceId = ID.web; }, payload => { payload.environments.edges.push(payload.environments.edges[0]); },
    payload => { payload.services.edges[0].node.name = 'foreign-service'; },
    payload => { payload.environments.edges[0].node.volumeInstances.edges[0].node.serviceId = ID.web; },
    payload => { payload.environments.edges[0].node.volumeInstances.edges[0].node.mountPath = '/foreign'; },
    payload => { payload.buckets = [{ id: ID.web }]; },
    payload => { payload.services.pageInfo = { hasNextPage: true }; },
  ])('refuses unrelated or incomplete resources %# with zero deletion', async mutate => {
    const payload = status(); mutate(payload); const h = harness({ status: () => payload });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow(/^SELF_HEAL_PREVIEW_CLEANUP_/u);
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('rechecks resource ownership immediately before deletion and rejects drift', async () => {
    const h = harness({ status: attempt => { const payload = status(); if (attempt === 2) payload.name = 'different-project'; return payload; } });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_PROJECT_MISMATCH');
    expect(h.command).toHaveBeenCalledTimes(2); expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('arms one fixed-expiry watchdog then independently reattests before delete', async () => {
    const h = harness(); const value = receipt({ expiresAt: '2026-10-14T16:01:00.000Z' });
    const result = await runSelfHealPreviewCleanup({ ...execute(value), watchdog: true }, h);
    expect(h.events[0].status).toBe('WATCHDOG_ARMED'); expect(h.events[0].expiresAt).toBe(value.expiresAt);
    expect(h.sleep.mock.calls).toEqual([[30_000], [30_000]]); expect(h.now()).toBe(NOW + 60_000);
    expect(result.status).toBe('DELETED');
  });
  it('does not renew the fixed deadline from caller mutation while waiting', async () => {
    const h = harness(); const value = receipt({ expiresAt: '2026-10-14T16:00:01.000Z' });
    h.sleep.mockImplementation(async () => { value.expiresAt = '2026-10-15T16:00:00.000Z'; });
    await expect(runSelfHealPreviewCleanup({ ...execute(value), watchdog: true }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_WATCHDOG_CLOCK_STALLED');
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
    expect(h.events[0].expiresAt).toBe('2026-10-14T16:00:01.000Z');
  });
  it('never equates scheduled deletion with absence and stops after the 60-second bound', async () => {
    const h = harness({ list: () => [{ id: ID.project, deletedAt: new Date(NOW).toISOString(), isPendingDeletion: true }] });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_ABSENCE_UNCONFIRMED');
    expect(error.receipt).toMatchObject({ status: 'FAILED', deletionRequested: true, absenceVerified: false });
    expect(h.now()).toBe(NOW + 60_000); expect(h.command.mock.calls.filter(call => call[1][0] === 'list')).toHaveLength(30);
    expect(h.command.mock.calls.filter(call => call[1][0] === 'delete')).toHaveLength(1);
  });
  it('coarsens arbitrary CLI errors and rejects oversized inventory', async () => {
    const h = harness({ commandError: 'token=secret-with-provider-payload' });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_CLI_FAILED'); expect(JSON.stringify(error.receipt)).not.toContain('secret-with-provider-payload');
    const oversized = harness(); oversized.command.mockResolvedValue({ stdout: 'x'.repeat(2 * 1024 * 1024 + 1), stderr: '' });
    await expect(runSelfHealPreviewCleanup(execute(), oversized)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_CLI_OUTPUT_INVALID');
  });
  it('parses only exact explicit CLI arguments and requires an external absolute receipt', () => {
    const path = temporaryReceipt(receipt());
    expect(parseSelfHealPreviewCleanupArgs(['--receipt-file', path])).toEqual({ receiptFile: path, execute: false, allowDeleteOwnedProject: false, watchdog: false });
    expect(readSelfHealPreviewCleanupReceipt(path)).toEqual(receipt());
    expect(() => readSelfHealPreviewCleanupReceipt(resolve('package.json'))).toThrow('SELF_HEAL_PREVIEW_CLEANUP_RECEIPT_PATH_INVALID');
    expect(() => parseSelfHealPreviewCleanupArgs(['--receipt-file', 'relative.json'])).toThrow();
    expect(() => parseSelfHealPreviewCleanupArgs(['--receipt-file', path, '--execute'])).toThrow('SELF_HEAL_PREVIEW_CLEANUP_AUTHORIZATION_REQUIRED');
    expect(() => parseSelfHealPreviewCleanupArgs(['--receipt-file', path, '--watchdog'])).toThrow();
    expect(() => parseSelfHealPreviewCleanupArgs(['--receipt-file', path, '--execute', '--execute', '--allow-delete-owned-project'])).toThrow();
    expect(() => parseSelfHealPreviewCleanupArgs(['--receipt-file', path, '--unknown'])).toThrow();
    expect(readFileSync(path, 'utf8')).not.toContain('TOKEN');
  });
  it('bounds receipt-file parsing and never imports executable receipt content', () => {
    const oversized = temporaryReceipt('x'.repeat(16_385)); const malformed = temporaryReceipt('throw new Error("must not execute")');
    expect(() => readSelfHealPreviewCleanupReceipt(oversized)).toThrow('SELF_HEAL_PREVIEW_CLEANUP_RECEIPT_PATH_INVALID');
    expect(() => readSelfHealPreviewCleanupReceipt(malformed)).toThrow('SELF_HEAL_PREVIEW_CLEANUP_RECEIPT_READ_FAILED');
  });
});
