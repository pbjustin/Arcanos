import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, linkSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  attestSelfHealPreviewCleanupTarget, parseSelfHealPreviewCleanupArgs,
  persistSelfHealPreviewCleanupResourceReceipt, readSelfHealPreviewCleanupReceipt,
  readSelfHealPreviewCleanupResourceReceipt, runSelfHealPreviewCleanup,
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
function connection(nodes) { return { edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: false } }; }
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
    if (commandName === 'api') {
      if (!/^query SelfHealPreviewCleanupOwnerInventory \{/u.test(args[1])
        || !args[1].includes('workspaceId: "1c9265a3-986f-4304-ad3e-5a874caab039", includeDeleted: true')
        || args.length !== 3 || args[2] !== '--compact' || /\bmutation\b/u.test(args[1])) throw new Error('UNEXPECTED_OWNER_INVENTORY_QUERY');
      const project = current && { ...current, buckets: Array.isArray(current.buckets) ? connection(current.buckets) : current.buckets };
      return { stdout: JSON.stringify(options.api?.(project) ?? { data: {
        me: { id: 'e1c58b83-8740-4318-9ee2-780c2a6f4e8b' }, projects: connection(project ? [project] : []),
      } }), stderr: '' };
    }
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
    ...(options.persistence === false ? {} : { persistResourceReceipt: jest.fn(async value => structuredClone(value)) }),
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
function publicationChild(path, body, value = { ...receipt(), resources: boundResources() }) {
  const source = `import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const path = ${JSON.stringify(path)}; const value = ${JSON.stringify(value)};
    const final = path + '.cleanup-resources.json';
    ${body}
    syncBuiltinESMExports();
    const { persistSelfHealPreviewCleanupResourceReceipt } = await import(${JSON.stringify(new URL('../scripts/self-heal-preview-cleanup.mjs', import.meta.url).href)});
    persistSelfHealPreviewCleanupResourceReceipt(path, value, { now: () => ${NOW} });`;
  try {
    execFileSync(process.execPath, ['--input-type=module', '--eval', source], { timeout: 5_000, windowsHide: true,
      maxBuffer: 16_384, env: { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}) }, stdio: 'pipe' });
    return 0;
  } catch (error) { if (Number.isInteger(error.status)) return error.status; throw error; }
}
afterEach(() => {
  for (const { path, directory } of tempFiles.splice(0)) {
    const stages = readdirSync(directory).filter(name => /^ownership\.json\.cleanup-resources\.json\.pending-[a-f0-9]{64}$/u.test(name));
    for (const target of [...stages.map(name => join(directory, name)), `${path}.cleanup-resources.json`, `${path}.linked.json`, path]) {
      try { if (lstatSync(target).isDirectory()) rmdirSync(target); else unlinkSync(target); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    rmdirSync(directory);
  }
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
  it('never accepts filtered project-null/list absence while owner includeDeleted inventory retains volumes', async () => {
    const current = status(); current.deletedAt = new Date(NOW + 48 * 60 * 60 * 1000).toISOString();
    const h = harness({ initialStatus: current, refuseResourceDelete: true, list: () => [],
      api: value => ({ data: { project: null, projects: connection([value]) } }) });
    await expect(runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h))
      .rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_SCHEDULED_RESOURCE_DELETE_REQUIRES_APPROVED_RECOVERY');
    expect(h.events.some(event => event.absenceVerified === true || event.resourceAbsenceVerified === true)).toBe(false);
    expect(h.command.mock.calls.some(call => call[1][0] === 'list')).toBe(false);
  });
  it('accepts complete owner-visible empty deleted metadata only as resource absence, with zero mutations', async () => {
    const current = status(true); current.deletedAt = new Date(NOW - 1000).toISOString(); current.environments = connection([]);
    const h = harness({ initialStatus: current });
    const result = await runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h);
    expect(result).toMatchObject({ status: 'RESOURCES_REMOVED_METADATA_RETAINED', resourceAbsenceVerified: true,
      projectAbsenceVerified: false, absenceVerified: false, projectMetadataRetained: true,
      environmentCount: 0, serviceCount: 0, volumeCount: 0 });
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each(['volume', 'service', 'bucket', 'environment'])('refuses a past-deleted tombstone retaining %s before any mutation', async kind => {
    const current = status(true); current.deletedAt = new Date(NOW - 1000).toISOString(); current.environments = connection([]);
    if (kind === 'volume') current.volumes = status().volumes;
    if (kind === 'service') current.services = status().services;
    if (kind === 'bucket') current.buckets = [{ id: ID.redis }];
    if (kind === 'environment') current.environments = status(true).environments;
    const h = harness({ initialStatus: current });
    const error = await runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h).catch(error => error);
    expect(error.message).toMatch(/^SELF_HEAL_PREVIEW_CLEANUP_(?:DELETED_PROJECT_RESOURCES_RETAINED|FOREIGN_RESOURCES)$/u);
    expect(h.events.some(event => event.resourceAbsenceVerified === true)).toBe(false);
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each(['omitted', 'empty-tombstone'])('requires the pinned owner before accepting %s absence', async kind => {
    const current = status(true); current.deletedAt = new Date(NOW - 1000).toISOString(); current.environments = connection([]);
    const h = harness({ initialStatus: current, api: value => ({ data: {
      me: { id: ID.web }, projects: connection(kind === 'omitted' ? [] : [value]),
    } }) });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_OWNER_IDENTITY_MISMATCH');
    expect(h.events.some(event => event.resourceAbsenceVerified === true)).toBe(false);
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each(['truncated-projects', 'missing-page-info', 'truncated-volumes', 'legacy-filtered-null', 'duplicate-project', 'foreign-workspace'])(
    'rejects incomplete or unscoped owner inventory %s before any mutation', async kind => {
      const current = status(true); current.deletedAt = new Date(NOW - 1000).toISOString(); current.environments = connection([]);
      const h = harness({ initialStatus: current, api: value => {
        const projects = connection([value]);
        if (kind === 'truncated-projects') projects.pageInfo.hasNextPage = true;
        if (kind === 'missing-page-info') delete projects.pageInfo;
        if (kind === 'truncated-volumes') value.volumes.pageInfo.hasNextPage = true;
        if (kind === 'duplicate-project') projects.edges.push(projects.edges[0]);
        if (kind === 'foreign-workspace') value.workspaceId = ID.web;
        if (kind === 'legacy-filtered-null') return { data: { project: null } };
        return { data: { me: { id: 'e1c58b83-8740-4318-9ee2-780c2a6f4e8b' }, projects } };
      } });
      await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow(/^SELF_HEAL_PREVIEW_CLEANUP_/u);
      expect(h.events.some(event => event.resourceAbsenceVerified === true)).toBe(false);
      expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
    });
  it.each(['403 Forbidden', '404 Project not found'])('never interprets %s as absence', async commandError => {
    const h = harness({ commandError });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_CLI_FAILED');
    expect(h.events.some(event => event.resourceAbsenceVerified === true)).toBe(false);
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
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
  it('requires durable persistence before an unbound pure caller can delete any resource', async () => {
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_DURABLE_RESOURCE_RECEIPT_REQUIRED');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each([
    value => ({ ...value, sourceSha: 'b'.repeat(40) }),
    value => ({ ...value, expiresAt: '2026-10-14T17:01:00.000Z' }),
    value => ({ ...value, resources: { ...value.resources, volumes: [] } }),
    () => undefined,
  ])('validates durable callback acknowledgement %# before any destructive command', async response => {
    const h = harness(); h.persistResourceReceipt.mockImplementation(async value => response(value));
    await expect(runSelfHealPreviewCleanup(execute(), h)).rejects.toThrow(/^SELF_HEAL_PREVIEW_CLEANUP_/u);
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('fails closed when durable persistence fails and does not reflect callback diagnostics', async () => {
    const h = harness(); h.persistResourceReceipt.mockRejectedValue(new Error('confidential-filesystem-marker'));
    const error = await runSelfHealPreviewCleanup(execute(), h).catch(error => error);
    expect(error.message).toBe('SELF_HEAL_PREVIEW_CLEANUP_FAILED');
    expect(JSON.stringify(error.receipt)).not.toContain('confidential-filesystem-marker');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it('awaits durable persistence acknowledgement before issuing the first destructive command', async () => {
    const h = harness(); let acknowledge; let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    h.persistResourceReceipt.mockImplementation(value => new Promise(resolve => {
      acknowledge = () => resolve(value); entered();
    }));
    const operation = runSelfHealPreviewCleanup(execute(), h);
    await waiting; expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
    acknowledge(); expect((await operation).resourceAbsenceVerified).toBe(true);
  });
  it('persists before the first deletion and resumes detached volumes from the same original unbound file after interruption', async () => {
    const original = receipt(); const path = temporaryReceipt(original); const companion = `${path}.cleanup-resources.json`;
    const originalBytes = readFileSync(path, 'utf8');
    const current = status(); current.services.edges.unshift(current.services.edges.splice(2, 1)[0]);
    const originalBindings = { services: current.services.edges.map(({ node }) => ({ ...node })), volumes: boundResources().volumes };
    const h = harness({ persistence: false, initialStatus: current }); const command = h.command; let interrupted = false;
    h.command = jest.fn(async (...args) => {
      if (interrupted) throw new Error('simulated-process-interruption');
      if (isMutation(args[1])) expect(existsSync(companion)).toBe(true);
      const result = await command(...args);
      if (args[1][0] === 'service') interrupted = true;
      return result;
    });
    const config = { ...execute(original), receiptFile: path };
    await expect(runSelfHealPreviewCleanup(config, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_CLI_FAILED');
    const firstMutations = h.command.mock.calls.map(call => call[1]).filter(isMutation);
    expect(firstMutations).toEqual([['service', 'delete', '--project', ID.project, '--environment', ID.environment, '--service', ID.postgres, '--yes', '--json']]);
    expect(h.current().environments.edges[0].node.volumeInstances.edges[0].node.serviceId).toBeNull();
    const companionBytes = readFileSync(companion, 'utf8');
    expect(JSON.parse(companionBytes)).toMatchObject({ version: 2, publicationId: expect.stringMatching(/^[a-f0-9]{64}$/u),
      receipt: { ...original, resources: originalBindings } });
    const resumed = harness({ persistence: false, initialStatus: structuredClone(h.current()) });
    const result = await runSelfHealPreviewCleanup({ ...config, receipt: readSelfHealPreviewCleanupReceipt(path) }, resumed);
    expect(result).toMatchObject({ status: 'RESOURCES_REMOVED_METADATA_RETAINED', resourceAbsenceVerified: true });
    const mutations = resumed.command.mock.calls.map(call => call[1]).filter(isMutation);
    expect(mutations.filter(args => args[0] === 'service').map(args => args[args.indexOf('--service') + 1]))
      .toEqual([ID.web, ID.worker, ID.redis]);
    expect(mutations.filter(args => args[0] === 'volume').map(args => args[args.indexOf('--volume') + 1]))
      .toEqual([ID.pgVolume, ID.redisVolume]);
    expect(mutations.every(args => args.includes(ID.project))).toBe(true);
    expect(JSON.stringify(mutations)).not.toContain(ID.pgVolumeInstance);
    expect(readFileSync(path, 'utf8')).toBe(originalBytes); expect(readFileSync(companion, 'utf8')).toBe(companionBytes);
    expect(resumed.events.some(event => event.status === 'RESOURCE_RECEIPT_DURABLE')).toBe(false);
  });
  it('captures newly provisioned owned resources durably at a watchdog deadline while retaining the original lease', async () => {
    const original = receipt({ expiresAt: '2026-10-14T16:00:01.000Z' }); const path = temporaryReceipt(original);
    const companion = `${path}.cleanup-resources.json`; const h = harness({ persistence: false, initialStatus: status(true) });
    const sleep = h.sleep; h.sleep = jest.fn(async ms => {
      expect(h.events[0].status).toBe('WATCHDOG_ARMED'); expect(existsSync(companion)).toBe(false);
      Object.assign(h.current(), status()); await sleep(ms);
    });
    const command = h.command; h.command = jest.fn(async (...args) => {
      if (isMutation(args[1])) expect(existsSync(companion)).toBe(true);
      return command(...args);
    });
    expect((await runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path, watchdog: true }, h)).resourceAbsenceVerified).toBe(true);
    expect(JSON.parse(readFileSync(companion, 'utf8')).receipt).toEqual({ ...original, resources: boundResources() });
    expect(h.now()).toBe(Date.parse(original.expiresAt));
  });
  it('reloads a matching companion at watchdog expiry before validating newly detached volumes', async () => {
    const original = receipt({ expiresAt: '2026-10-14T16:00:01.000Z' }); const path = temporaryReceipt(original);
    const h = harness({ persistence: false }); const sleep = h.sleep;
    h.sleep = jest.fn(async ms => {
      persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: boundResources() }, { now: h.now });
      const current = h.current(); current.services.edges = []; const env = current.environments.edges[0].node;
      env.serviceInstances.edges = []; for (const { node } of env.volumeInstances.edges) node.serviceId = null;
      await sleep(ms);
    });
    expect((await runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path, watchdog: true }, h)).resourceAbsenceVerified).toBe(true);
    expect(h.command.mock.calls.map(call => call[1]).filter(isMutation).filter(args => args[0] === 'service')).toEqual([]);
  });
  it('fails closed if a previously admitted companion disappears while the watchdog waits', async () => {
    const original = receipt({ expiresAt: '2026-10-14T16:00:01.000Z' }); const path = temporaryReceipt(original);
    persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: boundResources() }, { now: () => NOW });
    const h = harness({ persistence: false }); const sleep = h.sleep;
    h.sleep = jest.fn(async ms => { unlinkSync(`${path}.cleanup-resources.json`); await sleep(ms); });
    await expect(runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path, watchdog: true }, h))
      .rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_MISSING');
    expect(h.command.mock.calls.some(call => isMutation(call[1]))).toBe(false);
  });
  it.each([
    '{"partially-written":',
    JSON.stringify({ ...receipt(), sourceSha: 'b'.repeat(40), resources: boundResources() }),
    JSON.stringify({ ...receipt(), runId: 'another-owned-run', resources: boundResources() }),
    JSON.stringify({ ...receipt(), expiresAt: '2026-10-14T17:01:00.000Z', resources: boundResources() }),
    JSON.stringify({ ...receipt(), resources: { ...boundResources(), token: 'forbidden' } }),
    JSON.stringify(receipt()),
  ])('refuses malformed or foreign companion %# before CLI activity', async contents => {
    const path = temporaryReceipt(receipt()); writeFileSync(`${path}.cleanup-resources.json`, contents);
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow(/^SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_/u);
    expect(h.command).not.toHaveBeenCalled(); expect(readFileSync(`${path}.cleanup-resources.json`, 'utf8')).toBe(contents);
  });
  it.each([
    { version: 3, publicationId: 'c'.repeat(64) },
    { version: 2, publicationId: 'C'.repeat(64) },
    { version: 2, publicationId: ['c'.repeat(64)] },
    { version: 2, publicationId: '../foreign-path' },
    { version: 2, publicationId: 'c'.repeat(64), path: '../foreign-path' },
  ])('rejects malformed closed publication metadata %# before CLI activity', async publication => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    const contents = JSON.stringify({ ...publication, receipt: { ...receipt(), resources: boundResources() } });
    writeFileSync(final, contents); const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_INVALID');
    expect(h.command).not.toHaveBeenCalled(); expect(readFileSync(final, 'utf8')).toBe(contents);
  });
  it('accepts the same closed resource set in any API order without overwriting its original durable bytes', () => {
    const original = receipt(); const path = temporaryReceipt(original); const resources = boundResources();
    persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources }, { now: () => NOW });
    const companion = `${path}.cleanup-resources.json`; const before = readFileSync(companion, 'utf8');
    const reordered = { services: [...resources.services].reverse(), volumes: [...resources.volumes].reverse() };
    expect(persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: reordered }, { now: () => NOW }))
      .toEqual({ ...original, resources });
    expect(readFileSync(companion, 'utf8')).toBe(before);
    const different = structuredClone(resources); different.volumes[0].id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    expect(() => persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: different }, { now: () => NOW }))
      .toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_MISMATCH');
    expect(readFileSync(companion, 'utf8')).toBe(before);
  });
  it('recovers from an actual process exit before atomic publication without adopting its unpublished staging file', async () => {
    const original = receipt(); const path = temporaryReceipt(original); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, 'fs.linkSync = () => process.exit(73);')).toBe(73);
    expect(existsSync(final)).toBe(false);
    const staged = readdirSync(dirname(path)).filter(name => name.includes('.pending-'));
    expect(staged).toHaveLength(1); const stage = join(dirname(path), staged[0]);
    const unpublished = readFileSync(stage, 'utf8');
    expect(JSON.parse(unpublished).receipt).toEqual({ ...original, resources: boundResources() });
    expect(readSelfHealPreviewCleanupResourceReceipt(path, original, { now: () => NOW })).toBeNull();
    const h = harness({ persistence: false });
    expect((await runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path }, h)).resourceAbsenceVerified).toBe(true);
    expect(readFileSync(stage, 'utf8')).toBe(unpublished);
    expect(lstatSync(final).nlink).toBe(1); expect(readSelfHealPreviewCleanupReceipt(path)).toEqual(original);
  });
  it('ignores a partial unpublished staging file left by an actual process exit during write', () => {
    const original = receipt(); const path = temporaryReceipt(original); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, `const write = fs.writeFileSync; fs.writeFileSync = (descriptor, data, ...args) => {
      write(descriptor, data.slice(0, 31), ...args); process.exit(72);
    };`)).toBe(72);
    expect(existsSync(final)).toBe(false);
    const stages = readdirSync(dirname(path)).filter(name => name.includes('.pending-'));
    expect(stages).toHaveLength(1); const stage = join(dirname(path), stages[0]); const partial = readFileSync(stage, 'utf8');
    expect(() => JSON.parse(partial)).toThrow();
    expect(persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: boundResources() }, { now: () => NOW }))
      .toEqual({ ...original, resources: boundResources() });
    expect(readFileSync(stage, 'utf8')).toBe(partial); expect(lstatSync(final).nlink).toBe(1);
  });
  it('recovers from an actual process exit after atomic publication before staging-link removal', async () => {
    const original = receipt(); const path = temporaryReceipt(original); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, 'const link = fs.linkSync; fs.linkSync = (...args) => { link(...args); process.exit(74); };')).toBe(74);
    const published = readFileSync(final, 'utf8'); const value = JSON.parse(published);
    const stage = `${final}.pending-${value.publicationId}`;
    expect(lstatSync(final).nlink).toBe(2); expect(lstatSync(stage).ino).toBe(lstatSync(final).ino);
    const h = harness({ persistence: false });
    expect((await runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path }, h)).resourceAbsenceVerified).toBe(true);
    expect(lstatSync(final).nlink).toBe(1); expect(existsSync(stage)).toBe(false);
    expect(readFileSync(final, 'utf8')).toBe(published); expect(readSelfHealPreviewCleanupReceipt(path)).toEqual(original);
  });
  it('accepts the same single-link publication if another reader removes its stage between recovery inspections', () => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, 'const link = fs.linkSync; fs.linkSync = (...args) => { link(...args); process.exit(74); };')).toBe(74);
    const before = readFileSync(final, 'utf8'); const stage = `${final}.pending-${JSON.parse(before).publicationId}`;
    expect(publicationChild(path, `const stage = final + '.pending-' + JSON.parse(fs.readFileSync(final, 'utf8')).publicationId;
      const stat = fs.lstatSync; let inspections = 0; fs.lstatSync = (target, ...args) => {
        if (target === stage && ++inspections === 2) fs.unlinkSync(stage);
        return stat(target, ...args);
      };`)).toBe(0);
    expect(existsSync(stage)).toBe(false); expect(lstatSync(final).nlink).toBe(1); expect(readFileSync(final, 'utf8')).toBe(before);
  });
  it('preserves a matching concurrent publication winner and removes only its own unpublished loser', () => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, `const link = fs.linkSync; fs.linkSync = (...args) => {
      const descriptor = fs.openSync(final, 'wx', 0o600);
      fs.writeFileSync(descriptor, JSON.stringify({ version: 2, publicationId: 'c'.repeat(64), receipt: value }));
      fs.fsyncSync(descriptor); fs.closeSync(descriptor); return link(...args);
    };`)).toBe(0);
    expect(JSON.parse(readFileSync(final, 'utf8')).publicationId).toBe('c'.repeat(64));
    expect(readdirSync(dirname(path)).some(name => name.includes('.pending-'))).toBe(false);
    expect(lstatSync(final).nlink).toBe(1);
  });
  it('never overwrites a foreign record created concurrently at the final publication path', () => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, `const link = fs.linkSync; fs.linkSync = (...args) => {
      fs.writeFileSync(final, JSON.stringify({ ...value, sourceSha: 'b'.repeat(40) }), { flag: 'wx' });
      return link(...args);
    };`)).toBe(1);
    expect(JSON.parse(readFileSync(final, 'utf8')).sourceSha).toBe('b'.repeat(40));
    expect(() => readSelfHealPreviewCleanupResourceReceipt(path, receipt(), { now: () => NOW }))
      .toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_MISMATCH');
  });
  it('never replaces an empty directory created concurrently at the final publication path', () => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    expect(publicationChild(path, `const link = fs.linkSync; fs.linkSync = (...args) => {
      fs.mkdirSync(final); return link(...args);
    };`)).toBe(1);
    expect(lstatSync(final).isDirectory()).toBe(true); expect(readdirSync(final)).toEqual([]);
  });
  it.each(['missing', 'mismatched', 'extra'])('rejects an unproven %s publication hardlink without removing any file', async fault => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`;
    const publicationId = 'd'.repeat(64); const stage = `${final}.pending-${publicationId}`;
    const published = JSON.stringify({ version: 2, publicationId, receipt: { ...receipt(), resources: boundResources() } });
    writeFileSync(final, published); linkSync(final, `${path}.linked.json`);
    if (fault === 'mismatched') writeFileSync(stage, 'foreign-stage-must-stay');
    if (fault === 'extra') linkSync(final, stage);
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_INVALID');
    expect(h.command).not.toHaveBeenCalled(); expect(readFileSync(final, 'utf8')).toBe(published);
    expect(existsSync(`${path}.linked.json`)).toBe(true);
    if (fault === 'mismatched') expect(readFileSync(stage, 'utf8')).toBe('foreign-stage-must-stay');
    if (fault === 'extra') expect(lstatSync(final).nlink).toBe(3);
  });
  it('does not remove a recreated foreign staging file beside a completed single-link publication', () => {
    const original = receipt(); const path = temporaryReceipt(original); const final = `${path}.cleanup-resources.json`;
    persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: boundResources() }, { now: () => NOW });
    const stage = `${final}.pending-${JSON.parse(readFileSync(final, 'utf8')).publicationId}`;
    writeFileSync(stage, 'foreign-stage-must-stay');
    expect(readSelfHealPreviewCleanupResourceReceipt(path, original, { now: () => NOW })).toEqual({ ...original, resources: boundResources() });
    expect(readFileSync(stage, 'utf8')).toBe('foreign-stage-must-stay'); expect(lstatSync(final).nlink).toBe(1);
  });
  (process.platform === 'win32' ? it.skip : it)('rejects a symlink at the nonce-derived staging path without deleting its target', async () => {
    const path = temporaryReceipt(receipt()); const final = `${path}.cleanup-resources.json`; const publicationId = 'e'.repeat(64);
    writeFileSync(final, JSON.stringify({ version: 2, publicationId, receipt: { ...receipt(), resources: boundResources() } }));
    linkSync(final, `${path}.linked.json`); symlinkSync(`${path}.linked.json`, `${final}.pending-${publicationId}`);
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_INVALID');
    expect(h.command).not.toHaveBeenCalled(); expect(lstatSync(`${final}.pending-${publicationId}`).isSymbolicLink()).toBe(true);
    expect(lstatSync(final).nlink).toBe(2);
  });
  it('flushes and validates a complete companion even while its exclusive creator has not closed it', () => {
    const original = receipt(); const path = temporaryReceipt(original); const value = { ...original, resources: boundResources() };
    const descriptor = openSync(`${path}.cleanup-resources.json`, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(value), 'utf8');
      expect(readSelfHealPreviewCleanupResourceReceipt(path, original, { now: () => NOW })).toEqual(value);
    } finally { closeSync(descriptor); }
  });
  it('rejects a hardlinked companion instead of accepting shared mutable authority', async () => {
    const path = temporaryReceipt(receipt()); const linked = `${path}.linked.json`;
    writeFileSync(linked, JSON.stringify({ ...receipt(), resources: boundResources() })); linkSync(linked, `${path}.cleanup-resources.json`);
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_INVALID');
    expect(h.command).not.toHaveBeenCalled();
  });
  (process.platform === 'win32' ? it.skip : it)('rejects a symlink companion without following foreign authority', async () => {
    const path = temporaryReceipt(receipt()); const linked = `${path}.linked.json`;
    writeFileSync(linked, JSON.stringify({ ...receipt(), resources: boundResources() })); symlinkSync(linked, `${path}.cleanup-resources.json`);
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_INVALID');
    expect(h.command).not.toHaveBeenCalled();
  });
  it('does not renew or replace original owner identity from a companion or caller', async () => {
    const original = receipt(); const path = temporaryReceipt(original);
    persistSelfHealPreviewCleanupResourceReceipt(path, { ...original, resources: boundResources() }, { now: () => NOW });
    writeFileSync(path, JSON.stringify({ ...original, sourceSha: 'b'.repeat(40) }));
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_ORIGINAL_RECEIPT_CHANGED');
    expect(h.command).not.toHaveBeenCalled();
  });
  it('rejects adding resource authority to the original owner file after admission', async () => {
    const original = receipt(); const path = temporaryReceipt(original);
    writeFileSync(path, JSON.stringify({ ...original, resources: boundResources() }));
    const h = harness({ persistence: false });
    await expect(runSelfHealPreviewCleanup({ ...execute(original), receiptFile: path }, h)).rejects.toThrow('SELF_HEAL_PREVIEW_CLEANUP_ORIGINAL_RECEIPT_CHANGED');
    expect(h.command).not.toHaveBeenCalled();
  });
  it('keeps prebound receipt callers valid without requiring a separate persistence callback', async () => {
    const h = harness({ persistence: false });
    expect((await runSelfHealPreviewCleanup(execute(receipt({ resources: boundResources() })), h)).resourceAbsenceVerified).toBe(true);
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
      expect(args[1]).toMatch(/^query SelfHealPreviewCleanupOwnerInventory \{/u); expect(args[1]).not.toMatch(/\bmutation\b/u);
      expect(args[1]).toContain('workspaceId: "1c9265a3-986f-4304-ad3e-5a874caab039", includeDeleted: true');
      expect(args).not.toContain('--variables');
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
