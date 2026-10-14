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
  pgVolume: '77777777-7777-4777-8777-777777777777', redisVolume: '88888888-8888-4888-8888-888888888888',
  pgVolumeInstance: '99999999-9999-4999-8999-999999999999', redisVolumeInstance: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
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
    ]), volumes: connection(partial ? [] : [
      { id: ID.pgVolume, name: 'self-heal-pr1544-pg-test', projectId: ID.project },
      { id: ID.redisVolume, name: 'self-heal-pr1544-redis-test', projectId: ID.project },
    ]), environments: connection([{
      id: ID.environment, name: receipt().environmentName, deletedAt: null,
      serviceInstances: connection(partial ? [] : [ID.web, ID.worker, ID.postgres, ID.redis].map(serviceId => ({ serviceId }))),
      volumeInstances: connection(partial ? [] : [
        { id: ID.pgVolumeInstance, volumeId: ID.pgVolume, serviceId: ID.postgres, mountPath: '/var/lib/postgresql/data', environmentId: ID.environment,
          volume: { id: ID.pgVolume, name: 'self-heal-pr1544-pg-test', projectId: ID.project } },
        { id: ID.redisVolumeInstance, volumeId: ID.redisVolume, serviceId: ID.redis, mountPath: '/data', environmentId: ID.environment,
          volume: { id: ID.redisVolume, name: 'self-heal-pr1544-redis-test', projectId: ID.project } },
      ]),
    }]),
  };
}
function harness(options = {}) {
  let clockMs = options.now ?? NOW; let statuses = 0; let lists = 0;
  let current = options.initialStatus ?? status();
  const events = [];
  const command = jest.fn(async (_file, args) => {
    const commandName = args[0];
    if (options.commandError) throw new Error(options.commandError);
    if (commandName === 'status') {
      if (current?.deletedAt && options.allowScheduledStatus !== true) throw new Error('Project is deleted.');
      const payload = options.status?.(++statuses, structuredClone(current)) ?? current;
      return { stdout: JSON.stringify(payload), stderr: '' };
    }
    if (commandName === 'api') return { stdout: JSON.stringify(options.api?.(current) ?? { data: { project: current } }), stderr: '' };
    if (commandName === 'service' && args[1] === 'delete') {
      if (options.refuseResourceDelete) throw new Error('Project is deleted.');
      if (!options.retainServices) {
        const id = args[args.indexOf('--service') + 1];
        current.services.edges = current.services.edges.filter(({ node }) => node.id !== id);
        const env = current.environments.edges[0].node;
        env.serviceInstances.edges = env.serviceInstances.edges.filter(({ node }) => node.serviceId !== id);
        for (const { node } of env.volumeInstances.edges) if (node.serviceId === id) node.serviceId = null;
      }
      return { stdout: '{}', stderr: '' };
    }
    if (commandName === 'volume' && args.includes('delete')) {
      if (options.refuseResourceDelete) throw new Error('Project is deleted.');
      if (!options.retainVolumes) {
        const id = args[args.indexOf('--volume') + 1];
        current.volumes.edges = current.volumes.edges.filter(({ node }) => node.id !== id);
        const env = current.environments.edges[0].node;
        env.volumeInstances.edges = env.volumeInstances.edges.filter(({ node }) => node.volumeId !== id);
      }
      return { stdout: '{}', stderr: '' };
    }
    if (commandName === 'delete') {
      if (options.projectAbsent) current = null;
      else if (!options.noSchedule) current.deletedAt = new Date(clockMs + 48 * 60 * 60 * 1000).toISOString();
      return { stdout: JSON.stringify({ scheduled: true }), stderr: '' };
    }
    if (commandName === 'list') return { stdout: JSON.stringify(options.list?.(++lists) ?? (current ? [{ id: current.id, name: current.name, deletedAt: current.deletedAt }] : [])), stderr: '' };
    throw new Error(`UNEXPECTED_COMMAND_${commandName}`);
  });
  const sleep = jest.fn(async ms => { if (!options.stalledClock) clockMs += ms; });
  return { command, sleep, events, now: () => clockMs,
    env: { PATH: '/fixture/bin', RAILWAY_TOKEN: 'fixture-management-secret', OPENAI_API_KEY: 'mock-must-be-stripped' },
    invocation: { executable: 'railway-fixture', argsPrefix: [] }, onReceipt: event => events.push(event),
    current: () => current };
}
function isMutation(args) { return args[0] === 'delete' || (args[0] === 'service' && args[1] === 'delete') || (args[0] === 'volume' && args.includes('delete')); }
function boundResources() {
  const source = status();
  return { services: source.services.edges.map(({ node }) => node), volumes: source.environments.edges[0].node.volumeInstances.edges.map(({ node }) => ({
    id: node.volumeId, name: node.volume.name, serviceId: node.serviceId, mountPath: node.mountPath,
  })) };
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
  it('deletes exact services then global volumes before scheduling the empty project and verifies independent absence', async () => {
    const h = harness({ projectAbsent: true });
    const result = await runSelfHealPreviewCleanup(execute(), h);
    expect(result).toMatchObject({ status: 'DELETED', executed: true, deletionRequested: true, absenceVerified: true,
      resourceAbsenceVerified: true, projectAbsenceVerified: true, projectMetadataRetained: false, serviceCount: 0, volumeCount: 0 });
    expect(h.command.mock.calls.map(call => call[1]).filter(isMutation)).toEqual([
      ...[ID.web, ID.worker, ID.postgres, ID.redis].map(id => ['service', 'delete', '--project', ID.project, '--environment', ID.environment, '--service', id, '--yes', '--json']),
      ...[ID.pgVolume, ID.redisVolume].map(id => ['volume', '--project', ID.project, '--environment', ID.environment, 'delete', '--volume', id, '--yes', '--json']),
      ['delete', '--project', ID.project, '--yes', '--json'],
    ]);
    for (const [file, , options] of h.command.mock.calls) {
      expect(file).toBe('railway-fixture'); expect(options).toMatchObject({ windowsHide: true, maxBuffer: 2 * 1024 * 1024 });
      expect(options.timeout).toBeLessThanOrEqual(15_000); expect(options.env.RAILWAY_TOKEN).toBe('fixture-management-secret');
      expect(options.env).not.toHaveProperty('OPENAI_API_KEY');
    }
    expect(JSON.stringify(h.events)).not.toContain('fixture-management-secret');
  });
  it('allows cleanup after source head changes and receipt expiry without adopting another target', async () => {
    const h = harness({ now: NOW + 3 * 60 * 60 * 1000, status: (_attempt, payload) => {
      const instance = payload.environments.edges[0].node.serviceInstances.edges[0];
      if (instance) instance.node.latestDeployment = { meta: { commitHash: 'd'.repeat(40) } }; return payload;
    } });
    expect(validateSelfHealPreviewCleanupReceipt(receipt(), { now: h.now }).sourceSha).toBe('a'.repeat(40));
    expect((await runSelfHealPreviewCleanup(execute(), h)).status).toBe('RESOURCES_REMOVED_METADATA_RETAINED');
    expect(h.command.mock.calls.every(call => !call[1].includes('deploy'))).toBe(true);
  });
  it('attests empty or partial owned provisioning without requiring four completed services', () => {
    expect(attestSelfHealPreviewCleanupTarget(status(true), receipt())).toEqual({ serviceCount: 0, serviceInstanceCount: 0, volumeCount: 0, volumeInstanceCount: 0, environmentCount: 1 });
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
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('rechecks resource ownership immediately before deletion and rejects drift', async () => {
    const h = harness({ status: attempt => { const payload = status(); if (attempt === 2) payload.name = 'different-project'; return payload; } });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_PROJECT_MISMATCH');
    expect(h.command).toHaveBeenCalledTimes(2); expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('arms one fixed-expiry watchdog then independently reattests before delete', async () => {
    const h = harness(); const value = receipt({ expiresAt: '2026-10-14T16:01:00.000Z' });
    const result = await runSelfHealPreviewCleanup({ ...execute(value), watchdog: true }, h);
    expect(h.events[0].status).toBe('WATCHDOG_ARMED'); expect(h.events[0].expiresAt).toBe(value.expiresAt);
    expect(h.sleep.mock.calls).toEqual([[30_000], [30_000]]); expect(h.now()).toBe(NOW + 60_000);
    expect(result.status).toBe('RESOURCES_REMOVED_METADATA_RETAINED');
  });
  it('does not renew the fixed deadline from caller mutation while waiting', async () => {
    const h = harness(); const value = receipt({ expiresAt: '2026-10-14T16:00:01.000Z' });
    h.sleep.mockImplementation(async () => { value.expiresAt = '2026-10-15T16:00:00.000Z'; });
    await expect(runSelfHealPreviewCleanup({ ...execute(value), watchdog: true }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_WATCHDOG_CLOCK_STALLED');
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
    expect(h.events[0].expiresAt).toBe('2026-10-14T16:00:01.000Z');
  });
  it('distinguishes resource removal from retained 48-hour project metadata', async () => {
    const h = harness(); const result = await runSelfHealPreviewCleanup(execute(), h);
    expect(result).toMatchObject({ status: 'RESOURCES_REMOVED_METADATA_RETAINED', resourceAbsenceVerified: true,
      projectAbsenceVerified: false, absenceVerified: false, projectMetadataRetained: true,
      scheduledDeletionAt: new Date(NOW + 48 * 60 * 60 * 1000).toISOString() });
    expect(h.command.mock.calls.some(call => call[1][0] === 'api')).toBe(true);
    expect(h.command.mock.calls.filter(call => call[1][0] === 'delete')).toHaveLength(1);
  });
  it('uses global volume identities and never instance identities for deletion', async () => {
    const h = harness(); await runSelfHealPreviewCleanup(execute(), h);
    const deletes = h.command.mock.calls.map(call => call[1]).filter(args => args[0] === 'volume' && args.includes('delete'));
    expect(deletes.map(args => args[args.indexOf('--volume') + 1])).toEqual([ID.pgVolume, ID.redisVolume]);
    expect(JSON.stringify(deletes)).not.toContain(ID.pgVolumeInstance); expect(JSON.stringify(deletes)).not.toContain(ID.redisVolumeInstance);
    expect(deletes.every(args => args.indexOf('--project') < args.indexOf('delete') && args.indexOf('--environment') < args.indexOf('delete'))).toBe(true);
  });
  it('supports partial detached cleanup from closed receipt resource bindings without rescheduling the project', async () => {
    const current = status(); current.deletedAt = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
    current.services.edges = []; const env = current.environments.edges[0].node; env.serviceInstances.edges = [];
    for (const { node } of env.volumeInstances.edges) node.serviceId = null;
    const h = harness({ initialStatus: current });
    const result = await runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h);
    expect(result).toMatchObject({ status: 'RESOURCES_REMOVED_METADATA_RETAINED', resourceAbsenceVerified: true,
      projectAbsenceVerified: false, deletionRequested: false });
    const mutations = h.command.mock.calls.map(call => call[1]).filter(isMutation);
    expect(mutations).toHaveLength(2); expect(mutations.every(args => args[0] === 'volume')).toBe(true);
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('refuses detached volumes without prior resource bindings', async () => {
    const current = status(); current.services.edges = []; const env = current.environments.edges[0].node;
    env.serviceInstances.edges = []; for (const { node } of env.volumeInstances.edges) node.serviceId = null;
    const h = harness({ initialStatus: current });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_UNBOUND_VOLUME');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('refuses a foreign global volume instead of adopting it during partial cleanup', async () => {
    const current = status(); current.volumes.edges[0].node.id = ID.web;
    const h = harness({ initialStatus: current });
    await expect(runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_FOREIGN_VOLUMES');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each([null, {}, { services: [], volumes: [], token: 'forbidden' },
    { services: [{ id: ID.project, name: 'foreign-service' }], volumes: [] }])('rejects malformed optional resource bindings %# before CLI access', async resources => {
    const h = harness(); await expect(runSelfHealPreviewCleanup(execute(receipt({ resources })), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_BINDINGS_INVALID');
    expect(h.command).not.toHaveBeenCalled();
  });
  it('verifies no services or instances remain before attempting volume deletion or project scheduling', async () => {
    const h = harness({ retainServices: true });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_ABSENCE_UNCONFIRMED');
    expect(error.receipt.resourceAbsenceVerified).toBe(false); expect(h.now()).toBe(NOW + 60_000);
    expect(h.command.mock.calls.some(call => call[1][0] === 'volume' && call[1].includes('delete'))).toBe(false);
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('does not schedule project deletion while global volumes remain after a delete request', async () => {
    const h = harness({ retainVolumes: true });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_ABSENCE_UNCONFIRMED');
    expect(error.receipt.resourceAbsenceVerified).toBe(false); expect(h.now()).toBe(NOW + 60_000);
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('uses only the fixed read-only query when scheduled project status is rejected', async () => {
    const current = status(true); current.deletedAt = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
    const h = harness({ initialStatus: current });
    const result = await runSelfHealPreviewCleanup(execute(), h);
    expect(result.status).toBe('RESOURCES_REMOVED_METADATA_RETAINED');
    const queries = h.command.mock.calls.map(call => call[1]).filter(args => args[0] === 'api');
    expect(queries.length).toBeGreaterThan(0);
    for (const args of queries) {
      expect(args[1]).toMatch(/^query SelfHealPreviewCleanupInventory\(/u); expect(args[1]).not.toMatch(/\bmutation\b/u);
      expect(JSON.parse(args[args.indexOf('--variables') + 1])).toEqual({ projectId: ID.project });
      expect(args.at(-1)).toBe('--compact');
    }
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('fails closed for scheduled-project CLI deletion refusal and never issues an API mutation', async () => {
    const current = status(); current.deletedAt = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
    const h = harness({ initialStatus: current, refuseResourceDelete: true });
    const error = await runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_SCHEDULED_RESOURCE_DELETE_REQUIRES_APPROVED_RECOVERY');
    expect(error.receipt).toMatchObject({ resourceAbsenceVerified: false, projectMetadataRetained: true, deletionRequested: false });
    expect(h.command.mock.calls.map(call => call[1]).filter(args => args[0] === 'api').every(args => !/\bmutation\b/u.test(args[1]))).toBe(true);
    expect(h.command.mock.calls.filter(call => call[1][0] === 'service')).toHaveLength(1);
    expect(h.command.mock.calls.some(call => call[1][0] === 'delete')).toBe(false);
  });
  it('bounds project scheduling confirmation without claiming missing metadata', async () => {
    const h = harness({ noSchedule: true });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_PROJECT_DELETION_SCHEDULE_UNCONFIRMED');
    expect(error.receipt).toMatchObject({ resourceAbsenceVerified: true, projectAbsenceVerified: false, projectMetadataRetained: false });
    expect(h.now()).toBe(NOW + 60_000); expect(h.command.mock.calls.filter(call => call[1][0] === 'delete')).toHaveLength(1);
  });
  it('rechecks ownership between service deletions and stops before a new foreign resource', async () => {
    const h = harness({ status: (attempt, current) => {
      if (attempt === 4) current.services.edges.push({ node: { id: ID.pgVolumeInstance, name: 'foreign-service' } });
      return current;
    } });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_FOREIGN_SERVICES');
    const mutations = h.command.mock.calls.map(call => call[1]).filter(isMutation);
    expect(mutations).toEqual([['service', 'delete', '--project', ID.project, '--environment', ID.environment, '--service', ID.web, '--yes', '--json']]);
  });
  it('supplements CLI projections missing global volumes with the fixed owned metadata read', async () => {
    const h = harness({ status: (_attempt, current) => { delete current.volumes; return current; } });
    const result = await runSelfHealPreviewCleanup(execute(), h);
    expect(result.resourceAbsenceVerified).toBe(true);
    expect(h.command.mock.calls.some(call => call[1][0] === 'api')).toBe(true);
    expect(h.events.find(event => event.status === 'OWNERSHIP_RECHECKED').volumeDeleteRequests).toEqual([]);
  });
  it('fails closed on read-query errors without reflecting provider diagnostics or deleting resources', async () => {
    const h = harness({ status: (_attempt, current) => { delete current.volumes; return current; },
      api: () => ({ data: { project: null }, errors: [{ message: 'confidential-diagnostic-marker' }] }) });
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_INVENTORY_QUERY_FAILED');
    expect(JSON.stringify(error.receipt)).not.toContain('confidential-diagnostic-marker');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
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
