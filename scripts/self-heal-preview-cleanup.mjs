#!/usr/bin/env node
/** Receipt-bound cleanup/watchdog for one disposable self-healing preview. */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  buildBackstageHeavyRailwayCliEnvironment,
  railwayInvocationForBackstageHeavyProbe,
} from './railway-backstage-heavy-e2e-probe.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE = '1c9265a3-986f-4304-ad3e-5a874caab039';
const OWNER_USER_ID = 'e1c58b83-8740-4318-9ee2-780c2a6f4e8b';
const MAX_LEASE_MS = 7_200_000;
const MAX_BYTES = 2 * 1024 * 1024;
const CLI_TIMEOUT_MS = 15_000;
const ABSENCE_TIMEOUT_MS = 60_000;
const INVENTORY_MAX_PAGES = 5;
const INVENTORY_PAGE_SIZE = 100;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const FORBIDDEN_IDS = new Set([
  '7faf44e5-519c-4e73-8d7a-da9f389e6187', '8e4cb1eb-1441-4e83-b434-15c06c676a5f',
  'fb583147-6c39-4343-9267-500f357d25ab', '1765befb-b805-4051-9af9-28634e986886',
  'c4ade025-3f13-4fca-9309-5d0dd81396fe', '6647b5b1-d796-4783-b5f0-b8e356019ca6',
  '81e4a1cf-7ae4-48bf-8321-23641bb23c0e',
]);
const RECEIPT_KEYS = Object.freeze(['version', 'owner', 'repository', 'prNumber', 'sourceSha', 'runId',
  'projectId', 'projectName', 'workspaceId', 'environmentId', 'environmentName', 'issuedAt', 'expiresAt']);
const CLEANUP_INVENTORY_QUERY = `query SelfHealPreviewCleanupOwnerInventory($after: String) {
  me { id }
  projects(first: 100, after: $after, workspaceId: "${WORKSPACE}", includeDeleted: true) {
    edges { node {
    id name workspaceId deletedAt
    services(first: 100) { edges { node { id name } } pageInfo { hasNextPage } }
    volumes(first: 100) { edges { node { id name projectId } } pageInfo { hasNextPage } }
    buckets(first: 100) { edges { node { id } } pageInfo { hasNextPage } }
    environments(first: 100) { edges { node {
      id name deletedAt
      serviceInstances(first: 100) { edges { node { id serviceId serviceName environmentId } } pageInfo { hasNextPage } }
      volumeInstances(first: 100) { edges { node {
        id volumeId serviceId environmentId mountPath volume { id name projectId }
      } } pageInfo { hasNextPage } }
    } } pageInfo { hasNextPage } }
  } } pageInfo { hasNextPage endCursor } }
}`;
const SERVICES = new Map([
  ['Postgres', '/var/lib/postgresql/data'], ['Redis', '/data'],
  ['arcanos-web-pr1544-heavy', null], ['arcanos-worker-pr1544-heavy', null],
]);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));
export class SelfHealPreviewCleanupError extends Error {
  constructor(code) { super(`SELF_HEAL_PREVIEW_CLEANUP_${code}`); this.name = 'SelfHealPreviewCleanupError'; }
}
function fail(code) { throw new SelfHealPreviewCleanupError(code); }
function validId(value) { return typeof value === 'string' && UUID.test(value) && !FORBIDDEN_IDS.has(value); }
function iso(value) { const ms = Date.parse(value); return typeof value === 'string' && Number.isFinite(ms) && new Date(ms).toISOString() === value ? ms : NaN; }
function exact(value, keys) { return record(value) && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'); }
function resourceBindings(value) {
  if (!exact(value, ['services', 'volumes']) || !Array.isArray(value.services) || !Array.isArray(value.volumes)
    || value.services.length > 4 || value.volumes.length > 2) fail('RESOURCE_BINDINGS_INVALID');
  const services = value.services.map(service => {
    if (!exact(service, ['id', 'name']) || !validId(service.id) || !SERVICES.has(service.name)) fail('RESOURCE_BINDINGS_INVALID');
    return Object.freeze({ ...service });
  });
  const names = new Map(services.map(service => [service.id, service.name]));
  const volumes = value.volumes.map(volume => {
    if (!exact(volume, ['id', 'name', 'serviceId', 'mountPath']) || !validId(volume.id)
      || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(volume.name ?? '') || !names.has(volume.serviceId)
      || !SERVICES.get(names.get(volume.serviceId)) || volume.mountPath !== SERVICES.get(names.get(volume.serviceId))) fail('RESOURCE_BINDINGS_INVALID');
    return Object.freeze({ ...volume });
  });
  if (new Set(services.map(service => service.id)).size !== services.length
    || new Set(services.map(service => service.name)).size !== services.length
    || new Set(volumes.map(volume => volume.id)).size !== volumes.length
    || new Set(volumes.map(volume => volume.serviceId)).size !== volumes.length
    || new Set([...services.map(service => service.id), ...volumes.map(volume => volume.id)]).size !== services.length + volumes.length) fail('RESOURCE_BINDINGS_INVALID');
  return Object.freeze({ services: Object.freeze(services), volumes: Object.freeze(volumes) });
}

/** An expired receipt remains valid deletion authority for the same owned target. */
export function validateSelfHealPreviewCleanupReceipt(receipt, options = {}) {
  const now = options.now?.() ?? Date.now();
  if (!record(receipt) || !exact(receipt, Object.hasOwn(receipt, 'resources') ? [...RECEIPT_KEYS, 'resources'] : RECEIPT_KEYS)
    || receipt.version !== 1 || receipt.owner !== 'pbjustin' || receipt.repository !== 'pbjustin/Arcanos'
    || receipt.prNumber !== 1544 || !/^[0-9a-f]{40}$/u.test(receipt.sourceSha ?? '')
    || !/^[a-z0-9][a-z0-9-]{7,63}$/u.test(receipt.runId ?? '')
    || !validId(receipt.projectId) || !validId(receipt.environmentId) || receipt.projectId === receipt.environmentId
    || receipt.workspaceId !== WORKSPACE || !/^arc-pr1544-heavy-[a-z0-9][a-z0-9-]{0,13}$/u.test(receipt.projectName ?? '')
    || receipt.projectName.length > 32 || !/^backstage-heavy-pr-1544-e2e(?:-[a-z0-9]{1,16})?$/u.test(receipt.environmentName ?? '')) fail('RECEIPT_INVALID');
  const issued = iso(receipt.issuedAt); const expires = iso(receipt.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || issued > now || expires <= issued
    || expires - issued > MAX_LEASE_MS || (options.allowExpired === false && expires <= now)) fail('LEASE_INVALID');
  return Object.freeze({ ...receipt, ...(Object.hasOwn(receipt, 'resources') ? { resources: resourceBindings(receipt.resources) } : {}) });
}

function connection(value) {
  if (!record(value) || !Array.isArray(value.edges) || value.pageInfo?.hasNextPage === true) fail('INCOMPLETE_INVENTORY');
  return value.edges.map(edge => { if (!record(edge?.node)) fail('INCOMPLETE_INVENTORY'); return edge.node; });
}

/** Permit only the exact project, one exact environment, and its partial four-service topology. */
function cleanupInventory(status, receipt, options = {}) {
  const now = options.now?.() ?? Date.now();
  if (!record(status) || status.id !== receipt.projectId || status.name !== receipt.projectName
    || status.workspaceId !== WORKSPACE || !validId(status.id)
    || (status.deletedAt !== null && !Number.isFinite(iso(status.deletedAt)))) fail('PROJECT_MISMATCH');
  if (status.buckets !== undefined) {
    const buckets = Array.isArray(status.buckets) ? status.buckets : connection(status.buckets);
    if (buckets.length !== 0) fail('FOREIGN_RESOURCES');
  }
  const environments = connection(status.environments);
  // Owner-visible deleted project metadata can outlive all resource collections.
  // Only that exact empty tombstone is admissible; retained resources after the
  // deletion timestamp are neither absent nor authority for a recovery mutation.
  if (status.deletedAt !== null && iso(status.deletedAt) <= now) {
    if (environments.length !== 0 || connection(status.services).length !== 0
      || connection(status.volumes).length !== 0) fail('DELETED_PROJECT_RESOURCES_RETAINED');
    return { services: [], instances: [], globalVolumes: [], volumeInstances: [],
      bindings: options.bindings ?? receipt.resources ?? resourceBindings({ services: [], volumes: [] }),
      scheduledDeletionAt: status.deletedAt,
      counts: { serviceCount: 0, serviceInstanceCount: 0, volumeCount: 0, volumeInstanceCount: 0, environmentCount: 0 } };
  }
  if (environments.length !== 1) fail('ENVIRONMENT_MISMATCH');
  const environment = environments[0];
  if (environment.id !== receipt.environmentId || environment.name !== receipt.environmentName
    || environment.deletedAt !== null || !validId(environment.id)) fail('ENVIRONMENT_MISMATCH');
  const services = connection(status.services);
  if (services.length > 4 || new Set(services.map(service => service.id)).size !== services.length
    || new Set(services.map(service => service.name)).size !== services.length
    || services.some(service => !validId(service.id) || !SERVICES.has(service.name))) fail('FOREIGN_SERVICES');
  const expected = options.bindings ?? receipt.resources;
  const knownServices = expected?.services ?? services;
  const byId = new Map(knownServices.map(service => [service.id, service.name]));
  if (services.some(service => byId.get(service.id) !== service.name)) fail('FOREIGN_SERVICES');
  const instances = connection(environment.serviceInstances);
  if (new Set(instances.map(instance => instance.serviceId)).size !== instances.length
    || instances.some(instance => !byId.has(instance.serviceId)
      || (instance.environmentId !== undefined && instance.environmentId !== receipt.environmentId))) fail('FOREIGN_SERVICES');
  const volumes = connection(environment.volumeInstances);
  const globalVolumes = connection(status.volumes);
  if (volumes.length > 2 || new Set(volumes.map(volume => volume.id)).size !== volumes.length
    || globalVolumes.length > 2 || new Set(globalVolumes.map(volume => volume.id)).size !== globalVolumes.length
    || globalVolumes.some(volume => !validId(volume.id) || volume.projectId !== receipt.projectId
      || typeof volume.name !== 'string')) fail('FOREIGN_VOLUMES');
  const globalById = new Map(globalVolumes.map(volume => [volume.id, volume]));
  const expectedVolumes = expected ? new Map(expected.volumes.map(volume => [volume.id, volume])) : null;
  for (const volume of volumes) {
    const global = globalById.get(volume.volumeId);
    const binding = expectedVolumes?.get(volume.volumeId);
    if (!validId(volume.id) || !global || !record(volume.volume) || volume.volume.id !== volume.volumeId
      || volume.id === volume.volumeId || volume.volume.projectId !== receipt.projectId
      || volume.volume.name !== global.name
      || (volume.environmentId !== undefined && volume.environmentId !== receipt.environmentId)) fail('FOREIGN_VOLUMES');
    if (volume.serviceId === null || volume.serviceId === undefined) {
      if (!binding || services.some(service => service.id === binding.serviceId)) fail('UNBOUND_VOLUME');
    } else if (!byId.has(volume.serviceId) || !SERVICES.get(byId.get(volume.serviceId))
      || volume.mountPath !== SERVICES.get(byId.get(volume.serviceId))
      || (binding && binding.serviceId !== volume.serviceId)) fail('FOREIGN_VOLUMES');
  }
  let bindings = expected;
  if (!bindings) {
    const boundVolumes = globalVolumes.map(global => {
      const instance = volumes.find(volume => volume.volumeId === global.id);
      if (!instance || !instance.serviceId) fail('UNBOUND_VOLUME');
      return { id: global.id, name: global.name, serviceId: instance.serviceId, mountPath: instance.mountPath };
    });
    bindings = resourceBindings({ services, volumes: boundVolumes });
  }
  const boundById = new Map(bindings.volumes.map(volume => [volume.id, volume]));
  if (globalVolumes.some(volume => boundById.get(volume.id)?.name !== volume.name)) fail('FOREIGN_VOLUMES');
  return { services, instances, globalVolumes, volumeInstances: volumes, bindings,
    scheduledDeletionAt: status.deletedAt,
    counts: { serviceCount: services.length, serviceInstanceCount: instances.length,
      volumeCount: globalVolumes.length, volumeInstanceCount: volumes.length, environmentCount: 1 } };
}

export function attestSelfHealPreviewCleanupTarget(status, receipt, options = {}) {
  return cleanupInventory(status, receipt, options).counts;
}

export function parseSelfHealPreviewCleanupArgs(args) {
  const config = { receiptFile: null, execute: false, allowDeleteOwnedProject: false, watchdog: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (seen.has(name)) fail('ARGUMENT_INVALID'); seen.add(name);
    if (name === '--receipt-file') {
      const value = args[++index]; if (!value || !isAbsolute(value)) fail('RECEIPT_PATH_INVALID'); config.receiptFile = value;
    } else if (name === '--execute') config.execute = true;
    else if (name === '--allow-delete-owned-project') config.allowDeleteOwnedProject = true;
    else if (name === '--watchdog') config.watchdog = true;
    else fail('ARGUMENT_INVALID');
  }
  if (!config.receiptFile) fail('RECEIPT_PATH_INVALID');
  if (config.execute !== config.allowDeleteOwnedProject || (config.watchdog && !config.execute)) fail('AUTHORIZATION_REQUIRED');
  return config;
}

export function readSelfHealPreviewCleanupReceipt(path) {
  try {
    if (!isAbsolute(path)) fail('RECEIPT_PATH_INVALID');
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_384) fail('RECEIPT_PATH_INVALID');
    const resolved = realpathSync(path); const local = relative(ROOT, resolved);
    if (local === '' || (local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local))) fail('RECEIPT_PATH_INVALID');
    return JSON.parse(readFileSync(resolved, 'utf8'));
  } catch (error) {
    if (error instanceof SelfHealPreviewCleanupError) throw error;
    fail('RECEIPT_READ_FAILED');
  }
}

function sameBaseReceipt(expected, observed) {
  return RECEIPT_KEYS.every(key => expected[key] === observed[key]);
}
function bindingIdentity(resources) {
  const byId = (left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0;
  return JSON.stringify({ services: resources.services.map(item => [item.id, item.name]).sort(byId),
    volumes: resources.volumes.map(item => [item.id, item.name, item.serviceId, item.mountPath]).sort(byId) });
}
function validatedBoundReceipt(original, value, now) {
  const bound = validateSelfHealPreviewCleanupReceipt(value, { now });
  if (!bound.resources || !sameBaseReceipt(original, bound)
    || (original.resources && bindingIdentity(original.resources) !== bindingIdentity(bound.resources))) fail('RESOURCE_COMPANION_MISMATCH');
  return bound;
}
function resourceCompanionPath(receiptFile, original, now) {
  const disk = validateSelfHealPreviewCleanupReceipt(readSelfHealPreviewCleanupReceipt(receiptFile), { now });
  if (!sameBaseReceipt(original, disk)
    || Object.hasOwn(original, 'resources') !== Object.hasOwn(disk, 'resources')
    || (disk.resources && original.resources && bindingIdentity(disk.resources) !== bindingIdentity(original.resources))) fail('ORIGINAL_RECEIPT_CHANGED');
  return `${realpathSync(receiptFile)}.cleanup-resources.json`;
}
function syncCompanionDirectory(path) {
  // The file flush also works on Windows; Unix additionally supports flushing
  // the directory entry before another cleanup may use the new authority.
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
function sameFile(left, right) { return left.dev === right.dev && left.ino === right.ino; }
function publicationStagePath(path, publicationId) { return `${path}.pending-${publicationId}`; }
function recoverPublicationLink(path, publicationId, descriptor, opened) {
  const current = fstatSync(descriptor);
  if (current.nlink === 1) return;
  if (current.nlink !== 2 || !publicationId) fail('RESOURCE_COMPANION_INVALID');
  const stage = publicationStagePath(path, publicationId);
  let staged;
  try { staged = lstatSync(stage); }
  catch (error) {
    // A concurrent reader or the publisher may already have removed this link.
    if (error?.code === 'ENOENT' && fstatSync(descriptor).nlink === 1) return;
    fail('RESOURCE_COMPANION_INVALID');
  }
  if (fstatSync(descriptor).nlink === 1) return;
  if (!staged.isFile() || staged.isSymbolicLink() || staged.nlink !== 2 || !sameFile(staged, opened)) fail('RESOURCE_COMPANION_INVALID');
  let confirmed;
  try { confirmed = lstatSync(stage); }
  catch (error) {
    if (error?.code === 'ENOENT' && fstatSync(descriptor).nlink === 1) return;
    fail('RESOURCE_COMPANION_INVALID');
  }
  if (fstatSync(descriptor).nlink === 1) return;
  if (!confirmed.isFile() || confirmed.isSymbolicLink() || !sameFile(confirmed, opened)) fail('RESOURCE_COMPANION_INVALID');
  try { unlinkSync(stage); }
  catch (error) {
    if (error?.code !== 'ENOENT' || fstatSync(descriptor).nlink !== 1) fail('RESOURCE_COMPANION_INVALID');
  }
}

/** Reload a closed companion, recovering only its proven publication link. */
export function readSelfHealPreviewCleanupResourceReceipt(receiptFile, original, options = {}) {
  const now = options.now ?? Date.now;
  const owner = validateSelfHealPreviewCleanupReceipt(original, { now });
  const path = resourceCompanionPath(receiptFile, owner, now);
  let before;
  try { before = lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('RESOURCE_COMPANION_INVALID');
  }
  let descriptor;
  try {
    if (!before.isFile() || before.isSymbolicLink() || ![1, 2].includes(before.nlink) || before.size > 16_384) fail('RESOURCE_COMPANION_INVALID');
    descriptor = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || ![1, 2].includes(opened.nlink) || opened.size > 16_384 || !sameFile(before, opened)) fail('RESOURCE_COMPANION_INVALID');
    const bytes = Buffer.alloc(16_385);
    const length = readSync(descriptor, bytes, 0, bytes.length, 0);
    if (length > 16_384) fail('RESOURCE_COMPANION_INVALID');
    const value = JSON.parse(bytes.subarray(0, length).toString('utf8'));
    const published = exact(value, ['version', 'publicationId', 'receipt']);
    if (published && (value.version !== 2 || typeof value.publicationId !== 'string'
      || !/^[0-9a-f]{64}$/u.test(value.publicationId))) fail('RESOURCE_COMPANION_INVALID');
    // Previously completed single-link bound receipts remain readable.
    const bound = validatedBoundReceipt(owner, published ? value.receipt : value, now);
    resourceCompanionPath(receiptFile, owner, now);
    // The final name is linked only after the complete staging file is flushed.
    // Readers flush again before recovering a publisher interrupted after link.
    fsyncSync(descriptor); syncCompanionDirectory(path);
    recoverPublicationLink(path, published ? value.publicationId : null, descriptor, opened);
    syncCompanionDirectory(path);
    const after = lstatSync(path); const final = fstatSync(descriptor);
    if (!after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || final.nlink !== 1
      || !sameFile(after, opened) || !sameFile(final, opened) || final.size !== length) fail('RESOURCE_COMPANION_INVALID');
    resourceCompanionPath(receiptFile, owner, now);
    return bound;
  }
  catch (error) {
    if (error instanceof SelfHealPreviewCleanupError && ['SELF_HEAL_PREVIEW_CLEANUP_RESOURCE_COMPANION_MISMATCH',
      'SELF_HEAL_PREVIEW_CLEANUP_ORIGINAL_RECEIPT_CHANGED'].includes(error.message)) throw error;
    fail('RESOURCE_COMPANION_INVALID');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

/** Persist validated resource authority before the first destructive operation. */
export function persistSelfHealPreviewCleanupResourceReceipt(receiptFile, value, options = {}) {
  const now = options.now ?? Date.now;
  const original = validateSelfHealPreviewCleanupReceipt(readSelfHealPreviewCleanupReceipt(receiptFile), { now });
  const bound = validatedBoundReceipt(original, value, now);
  const path = resourceCompanionPath(receiptFile, original, now);
  const existing = readSelfHealPreviewCleanupResourceReceipt(receiptFile, original, { now });
  if (existing) {
    if (bindingIdentity(existing.resources) !== bindingIdentity(bound.resources)) fail('RESOURCE_COMPANION_MISMATCH');
    return existing;
  }
  const publicationId = randomBytes(32).toString('hex');
  const stage = publicationStagePath(path, publicationId);
  let descriptor;
  try {
    descriptor = openSync(stage, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ version: 2, publicationId, receipt: bound })}\n`, 'utf8');
    fsyncSync(descriptor);
    const staged = fstatSync(descriptor);
    try { linkSync(stage, path); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const winner = readSelfHealPreviewCleanupResourceReceipt(receiptFile, original, { now });
      if (!winner || bindingIdentity(winner.resources) !== bindingIdentity(bound.resources)) fail('RESOURCE_COMPANION_MISMATCH');
      const remaining = lstatSync(stage);
      if (!remaining.isFile() || remaining.isSymbolicLink() || remaining.nlink !== 1 || !sameFile(remaining, staged)) fail('RESOURCE_COMPANION_INVALID');
      unlinkSync(stage); syncCompanionDirectory(path);
      return winner;
    }
    syncCompanionDirectory(path);
    const stored = readSelfHealPreviewCleanupResourceReceipt(receiptFile, original, { now });
    if (!stored || bindingIdentity(stored.resources) !== bindingIdentity(bound.resources)) fail('RESOURCE_COMPANION_MISMATCH');
    return stored;
  } catch (error) {
    if (error instanceof SelfHealPreviewCleanupError) throw error;
    fail('RESOURCE_COMPANION_WRITE_FAILED');
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

async function cli(args, options, timeout = CLI_TIMEOUT_MS, json = true) {
  try {
    const env = options.env ?? process.env;
    const invocation = options.invocation ?? railwayInvocationForBackstageHeavyProbe(process.platform, env.APPDATA, process.execPath);
    const command = options.command ?? promisify(execFile);
    const result = await command(invocation.executable, [...invocation.argsPrefix, ...args], {
      env: buildBackstageHeavyRailwayCliEnvironment(env), encoding: 'utf8', windowsHide: true,
      maxBuffer: MAX_BYTES, timeout: Math.max(1, Math.min(timeout, CLI_TIMEOUT_MS)),
    });
    if (typeof result?.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_BYTES
      || (typeof result.stderr === 'string' && Buffer.byteLength(result.stderr) > MAX_BYTES)) fail('CLI_OUTPUT_INVALID');
    return json ? JSON.parse(result.stdout) : null;
  } catch (error) {
    if (error instanceof SelfHealPreviewCleanupError) throw error;
    fail('CLI_FAILED');
  }
}

async function readOwnedProject(receipt, options, deadline) {
  const now = options.now ?? Date.now;
  const inventoryDeadline = Math.min(now() + ABSENCE_TIMEOUT_MS, deadline ?? Infinity);
  const timeout = () => {
    const remaining = inventoryDeadline - now();
    if (remaining <= 0) fail('RESOURCE_ABSENCE_UNCONFIRMED');
    return Math.min(CLI_TIMEOUT_MS, remaining);
  };
  let status;
  try {
    status = await cli(['status', '--project', receipt.projectId, '--environment', receipt.environmentId, '--json'], options, timeout());
  } catch (error) {
    if (!(error instanceof SelfHealPreviewCleanupError) || error.message !== 'SELF_HEAL_PREVIEW_CLEANUP_CLI_FAILED') throw error;
  }
  timeout();
  if (status?.volumes && status.deletedAt === null) return status;
  // CLI status rejects a project as soon as deletion is scheduled, and its
  // normal projection omits global volumes. Per-project reads and ordinary
  // project lists filter deleted targets, so neither is absence evidence.
  // Traverse a bounded, complete owner-visible includeDeleted collection;
  // deletion never falls back to an API mutation or a different target.
  const complete = value => {
    if (value?.pageInfo?.hasNextPage !== false) fail('INCOMPLETE_INVENTORY');
    return connection(value);
  };
  const projectIds = new Set(); const cursors = new Set();
  let after = null; let project;
  for (let page = 0; page < INVENTORY_MAX_PAGES; page += 1) {
    const response = await cli(['api', CLEANUP_INVENTORY_QUERY, '--variables', JSON.stringify({ after }), '--compact'], options, timeout());
    timeout();
    if (!record(response) || (response.errors !== undefined && (!Array.isArray(response.errors) || response.errors.length > 0))
      || !record(response.data) || !Object.hasOwn(response.data, 'projects')) fail('INVENTORY_QUERY_FAILED');
    if (response.data.me?.id !== OWNER_USER_ID) fail('OWNER_IDENTITY_MISMATCH');
    const collection = response.data.projects;
    if (!record(collection) || !Array.isArray(collection.edges) || !record(collection.pageInfo)
      || typeof collection.pageInfo.hasNextPage !== 'boolean'
      || !Object.hasOwn(collection.pageInfo, 'endCursor')) fail('INCOMPLETE_INVENTORY');
    if (collection.edges.length > INVENTORY_PAGE_SIZE) fail('INVENTORY_LIMIT_EXCEEDED');
    for (const edge of collection.edges) {
      const candidate = edge?.node;
      if (!record(candidate) || !UUID.test(candidate.id ?? '') || candidate.workspaceId !== WORKSPACE
        || projectIds.has(candidate.id)) fail('PROJECT_LIST_INVALID');
      projectIds.add(candidate.id);
      if (candidate.id === receipt.projectId) project = candidate;
    }
    if (!collection.pageInfo.hasNextPage) break;
    const cursor = collection.pageInfo.endCursor;
    if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 1024
      || cursor.trim() !== cursor || /[\u0000-\u001f\u007f]/u.test(cursor)
      || cursors.has(cursor) || collection.edges.length === 0) fail('INVENTORY_CURSOR_INVALID');
    if (page + 1 === INVENTORY_MAX_PAGES || projectIds.size >= INVENTORY_PAGE_SIZE * INVENTORY_MAX_PAGES) fail('INVENTORY_LIMIT_EXCEEDED');
    cursors.add(cursor); after = cursor;
  }
  if (!project) return null;
  complete(project.services); complete(project.volumes); complete(project.buckets);
  const environments = complete(project.environments);
  for (const environment of environments) {
    complete(environment.serviceInstances); complete(environment.volumeInstances);
  }
  return project;
}

function noServices(inventory) { return inventory.services.length === 0 && inventory.instances.length === 0; }
function noResources(inventory) { return noServices(inventory) && inventory.globalVolumes.length === 0 && inventory.volumeInstances.length === 0; }

/** No head lookup is needed: cleanup authority remains bound to the receipt's resource identities. */
export async function runSelfHealPreviewCleanup(config, options = {}) {
  const now = options.now ?? Date.now; const wait = options.sleep ?? sleep;
  const receipt = validateSelfHealPreviewCleanupReceipt(config.receipt, { now });
  if (typeof config.execute !== 'boolean' || typeof config.allowDeleteOwnedProject !== 'boolean'
    || config.execute !== config.allowDeleteOwnedProject || (config.watchdog && !config.execute)) fail('AUTHORIZATION_REQUIRED');
  const output = { version: 1, owner: receipt.owner, repository: receipt.repository,
    runId: receipt.runId, sourceSha: receipt.sourceSha, projectId: receipt.projectId,
    environmentId: receipt.environmentId, expiresAt: receipt.expiresAt,
    executed: Boolean(config.execute), deletionRequested: false, absenceVerified: false,
    resourceAbsenceVerified: false, projectAbsenceVerified: false, projectMetadataRetained: false,
    scheduledDeletionAt: null, serviceDeleteRequests: [], volumeDeleteRequests: [] };
  const emit = (status, extra = {}) => {
    const event = { ...output, serviceDeleteRequests: [...output.serviceDeleteRequests],
      volumeDeleteRequests: [...output.volumeDeleteRequests], status, ...extra, observedAt: new Date(now()).toISOString() };
    options.onReceipt?.(event); return event;
  };
  if (!config.execute) return emit('DRY_RUN');
  try {
    const loadResources = options.loadResourceReceipt ?? (config.receiptFile
      ? () => readSelfHealPreviewCleanupResourceReceipt(config.receiptFile, receipt, { now }) : null);
    const persistResources = options.persistResourceReceipt ?? (config.receiptFile
      ? bound => persistSelfHealPreviewCleanupResourceReceipt(config.receiptFile, bound, { now }) : null);
    let authority = receipt;
    let companionSeen = false;
    const reloadResources = async () => {
      const stored = await loadResources?.(receipt);
      if (stored !== null && stored !== undefined) {
        authority = validatedBoundReceipt(receipt, stored, now); companionSeen = true;
      } else {
        if (companionSeen) fail('RESOURCE_COMPANION_MISSING');
        authority = receipt;
      }
    };
    await reloadResources();
    let status = await readOwnedProject(receipt, options);
    if (status !== null) cleanupInventory(status, authority, { now });
    if (config.watchdog) {
      emit('WATCHDOG_ARMED');
      const expires = Date.parse(receipt.expiresAt);
      // Fixed finite deadline; the receipt is never reloaded or renewed.
      for (let attempt = 0; now() < expires; attempt += 1) {
        if (attempt >= 240) fail('WATCHDOG_CLOCK_STALLED');
        await wait(Math.min(30_000, expires - now()));
      }
    }
    await reloadResources();
    status = await readOwnedProject(receipt, options);
    const finishAbsent = () => {
      Object.assign(output, { resourceAbsenceVerified: true, projectAbsenceVerified: true,
        absenceVerified: true, projectMetadataRetained: false, serviceCount: 0, serviceInstanceCount: 0,
        volumeCount: 0, volumeInstanceCount: 0, environmentCount: 0 });
      return emit('DELETED');
    };
    if (status === null) return finishAbsent();
    let inventory = cleanupInventory(status, authority, { now });
    if (!authority.resources && !noResources(inventory)) {
      if (typeof persistResources !== 'function') fail('DURABLE_RESOURCE_RECEIPT_REQUIRED');
      const requested = validateSelfHealPreviewCleanupReceipt({ ...receipt, resources: inventory.bindings }, { now });
      const stored = validatedBoundReceipt(receipt, await persistResources(requested), now);
      if (bindingIdentity(stored.resources) !== bindingIdentity(requested.resources)) fail('RESOURCE_COMPANION_MISMATCH');
      authority = stored; emit('RESOURCE_RECEIPT_DURABLE');
    }
    const bindings = authority.resources ?? inventory.bindings;
    Object.assign(output, inventory.counts, { resources: bindings,
      projectMetadataRetained: inventory.scheduledDeletionAt !== null,
      scheduledDeletionAt: inventory.scheduledDeletionAt }); emit('OWNERSHIP_RECHECKED');
    const refresh = async deadline => {
      const latest = await readOwnedProject(receipt, options, deadline);
      if (latest === null) return null;
      const observed = cleanupInventory(latest, receipt, { now, bindings });
      Object.assign(output, observed.counts, { projectMetadataRetained: observed.scheduledDeletionAt !== null,
        scheduledDeletionAt: observed.scheduledDeletionAt });
      if (!noResources(observed)) output.resourceAbsenceVerified = false;
      return observed;
    };
    const poll = async predicate => {
      const deadline = now() + ABSENCE_TIMEOUT_MS;
      for (let attempt = 0; attempt < 31 && now() < deadline; attempt += 1) {
        const latest = await refresh(deadline);
        if (latest === null || predicate(latest)) return latest;
        if (attempt < 30) await wait(Math.min(2000, Math.max(0, deadline - now())));
      }
      fail('RESOURCE_ABSENCE_UNCONFIRMED');
    };
    for (const service of bindings.services) {
      inventory = await refresh(); if (inventory === null) return finishAbsent();
      if (!inventory.services.some(current => current.id === service.id)) continue;
      try {
        await cli(['service', 'delete', '--project', receipt.projectId, '--environment', receipt.environmentId,
          '--service', service.id, '--yes', '--json'], options, CLI_TIMEOUT_MS, false);
      } catch (error) {
        if (inventory.scheduledDeletionAt !== null) fail('SCHEDULED_RESOURCE_DELETE_REQUIRES_APPROVED_RECOVERY');
        throw error;
      }
      output.serviceDeleteRequests.push(service.id); emit('SERVICE_DELETE_REQUESTED');
    }
    inventory = await poll(noServices); if (inventory === null) return finishAbsent();
    for (const volume of bindings.volumes) {
      inventory = await refresh(); if (inventory === null) return finishAbsent();
      if (!inventory.globalVolumes.some(current => current.id === volume.id)) continue;
      try {
        await cli(['volume', '--project', receipt.projectId, '--environment', receipt.environmentId,
          'delete', '--volume', volume.id, '--yes', '--json'], options, CLI_TIMEOUT_MS, false);
      } catch (error) {
        if (inventory.scheduledDeletionAt !== null) fail('SCHEDULED_RESOURCE_DELETE_REQUIRES_APPROVED_RECOVERY');
        throw error;
      }
      output.volumeDeleteRequests.push(volume.id); emit('VOLUME_DELETE_REQUESTED');
    }
    inventory = await poll(noResources); if (inventory === null) return finishAbsent();
    Object.assign(output, inventory.counts, { resourceAbsenceVerified: true }); emit('RESOURCES_ABSENT');
    // Scheduling a project deletion retains its metadata for 48 hours. It is
    // performed only after independently observing no services or volumes.
    if (inventory.scheduledDeletionAt === null) {
      inventory = await refresh(); if (inventory === null) return finishAbsent();
      if (!noResources(inventory)) { output.resourceAbsenceVerified = false; fail('RESOURCES_REAPPEARED'); }
      if (inventory.scheduledDeletionAt === null) {
        await cli(['delete', '--project', receipt.projectId, '--yes', '--json'], options, CLI_TIMEOUT_MS, false);
        output.deletionRequested = true; emit('PROJECT_DELETION_SCHEDULE_REQUESTED');
      }
    }
    const deadline = now() + ABSENCE_TIMEOUT_MS;
    for (let attempt = 0; attempt < 31 && now() < deadline; attempt += 1) {
      inventory = await refresh(deadline); if (inventory === null) return finishAbsent();
      if (!noResources(inventory)) { output.resourceAbsenceVerified = false; fail('RESOURCES_REAPPEARED'); }
      if (inventory.scheduledDeletionAt !== null) {
        Object.assign(output, { projectMetadataRetained: true, scheduledDeletionAt: inventory.scheduledDeletionAt });
        return emit('RESOURCES_REMOVED_METADATA_RETAINED');
      }
      if (attempt < 30) await wait(Math.min(2000, Math.max(0, deadline - now())));
    }
    fail('PROJECT_DELETION_SCHEDULE_UNCONFIRMED');
  } catch (error) {
    const code = error instanceof SelfHealPreviewCleanupError ? error.message : 'SELF_HEAL_PREVIEW_CLEANUP_FAILED';
    const failure = emit('FAILED', { errorCode: code });
    if (error instanceof SelfHealPreviewCleanupError) { error.receipt = failure; throw error; }
    const safeError = new SelfHealPreviewCleanupError('FAILED'); safeError.receipt = failure; throw safeError;
  }
}

async function main() {
  let failure;
  try {
    const config = parseSelfHealPreviewCleanupArgs(process.argv.slice(2));
    await runSelfHealPreviewCleanup({ ...config, receipt: readSelfHealPreviewCleanupReceipt(config.receiptFile) }, {
      onReceipt: receipt => process.stdout.write(`${JSON.stringify(receipt)}\n`),
    });
  } catch (error) {
    failure = error instanceof SelfHealPreviewCleanupError ? error.message : 'SELF_HEAL_PREVIEW_CLEANUP_FAILED';
    process.stderr.write(`${failure}\n`); process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) void main();
