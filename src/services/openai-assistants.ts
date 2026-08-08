import { randomUUID } from 'crypto';
import { constants as fsConstants, type BigIntStats } from 'fs';
import type OpenAI from 'openai';
import fs from 'fs/promises';
import path from 'path';

import { config } from '@platform/runtime/config.js';
import { aiLogger } from '@platform/logging/structuredLogging.js';
import {
  normalizeAssistantName,
  validateAssistantRegistryCandidate
} from '@platform/runtime/assistantRegistryCandidate.js';
import {
  assertProtectedConfigIntegrity,
  prepareAssistantRegistryIntegrityUpdate,
} from '@services/safety/configIntegrity.js';

import { requireOpenAIClientOrAdapter } from './openai/clientBridge.js';

export { normalizeAssistantName };

export interface AssistantInfo {
  id: string;
  name: string | null;
  instructions: string | null;
  tools: OpenAI.Beta.Assistants.Assistant['tools'] | null;
  model?: string | null;
}

export interface AssistantRecord extends AssistantInfo {
  normalizedName: string;
}

export type AssistantRegistry = Record<string, AssistantRecord>;

export interface AssistantRegistrySyncResult {
  changed: boolean;
  registry: AssistantRegistry;
}

type AssistantListPage = Awaited<
  ReturnType<OpenAI['beta']['assistants']['list']>
>;

const LOG_CONTEXT = { module: 'assistant-sync' } as const;
const ASSISTANT_LIST_PAGE_LIMIT = 20;
const ASSISTANT_LIST_MAX_PAGES = 50;
const ASSISTANT_LIST_MAX_RECORDS = 1_000;
const ASSISTANT_ID_MAX_LENGTH = 256;
const ASSISTANT_NAME_MAX_LENGTH = 256;
const ASSISTANT_MODEL_MAX_LENGTH = 256;
const ASSISTANT_INSTRUCTIONS_MAX_LENGTH = 131_072;
const ASSISTANT_TOOLS_MAX_BYTES = 65_536;
const ASSISTANT_RECORD_MAX_BYTES = 196_608;
const ASSISTANT_REGISTRY_MAX_BYTES = 16 * 1024 * 1024;
const REGISTRY_PATH_MAX_LENGTH = 4_096;
const ASSISTANT_TOOLS_MAX_DEPTH = 32;
const ASSISTANT_TOOLS_MAX_NODES = 4_096;

let liveRegistry: AssistantRegistry | null = null;
let registryOperationTail: Promise<void> = Promise.resolve();
let assistantRegistrySyncActive = false;

export class AssistantRegistryUnavailableError extends Error {
  constructor() {
    super('Assistant registry is unavailable.');
    this.name = 'AssistantRegistryUnavailableError';
  }
}

export class AssistantRegistrySyncError extends Error {
  constructor() {
    super('Assistant registry synchronization failed.');
    this.name = 'AssistantRegistrySyncError';
  }
}

export class AssistantRegistrySyncInProgressError extends Error {
  constructor() {
    super('Assistant registry synchronization is already running.');
    this.name = 'AssistantRegistrySyncInProgressError';
  }
}

interface ResolvedRegistryTarget {
  absolutePath: string;
  canonicalParentPath: string;
  canonicalTargetPath: string;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compareStrings(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function safeAssistantRegistryWarn(
  message: string,
  context: Record<string, unknown>,
  metadata: Record<string, unknown>
): void {
  try {
    aiLogger.warn(message, context, metadata);
  } catch {
    // Observability must not alter registry availability semantics.
  }
}

function safeAssistantRegistryInfo(
  message: string,
  context: Record<string, unknown>,
  metadata: Record<string, unknown>
): void {
  try {
    aiLogger.info(message, context, metadata);
  } catch {
    // Observability must not turn a committed sync into a false failure.
  }
}

function safeAssistantRegistryError(
  message: string,
  context: Record<string, unknown>,
  metadata: Record<string, unknown>
): void {
  try {
    aiLogger.error(message, context, metadata);
  } catch {
    // The caller still receives the fixed, sanitized service error.
  }
}

function startAssistantRegistryTimer(
  context: Record<string, unknown>
): () => void {
  try {
    const endTimer = aiLogger.startTimer('assistant-sync', context);
    return (): void => {
      try {
        endTimer();
      } catch {
        // Timer reporting is not part of synchronization correctness.
      }
    };
  } catch {
    return () => undefined;
  }
}

function isFilesystemRoot(candidatePath: string): boolean {
  const resolvedPath = path.resolve(candidatePath);
  const rootPath = path.parse(resolvedPath).root;
  return process.platform === 'win32'
    ? resolvedPath.toLowerCase() === rootPath.toLowerCase()
    : resolvedPath === rootPath;
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameResolvedPath(left: string, right: string): boolean {
  const resolvedLeft = path.resolve(left);
  const resolvedRight = path.resolve(right);
  return process.platform === 'win32'
    ? resolvedLeft.toLowerCase() === resolvedRight.toLowerCase()
    : resolvedLeft === resolvedRight;
}

function createRegistry(
  entries: Iterable<readonly [string, AssistantRecord]> = []
): AssistantRegistry {
  const registry = Object.create(null) as AssistantRegistry;
  for (const [key, record] of entries) {
    registry[key] = record;
  }
  return registry;
}

function cloneRegistry(registry: AssistantRegistry): AssistantRegistry {
  return createRegistry(
    Object.entries(registry).map(([key, record]) => [
      key,
      structuredClone(record),
    ])
  );
}

function getOwnAssistantRecord(
  registry: AssistantRegistry,
  key: string
): AssistantRecord | undefined {
  return Object.prototype.hasOwnProperty.call(registry, key)
    ? registry[key]
    : undefined;
}

async function runSerializedRegistryOperation<T>(
  operation: () => Promise<T>
): Promise<T> {
  const pending = registryOperationTail.then(operation, operation);
  registryOperationTail = pending.then(
    () => undefined,
    () => undefined
  );
  return pending;
}

async function resolveRegistryTarget(): Promise<ResolvedRegistryTarget> {
  const configuredPath = config.assistantSync.registryPath;
  if (
    typeof configuredPath !== 'string'
    || configuredPath.length === 0
    || configuredPath.length > REGISTRY_PATH_MAX_LENGTH
    || configuredPath.includes('\0')
  ) {
    throw new AssistantRegistryUnavailableError();
  }

  const absolutePath = path.resolve(configuredPath);
  if (
    absolutePath.length > REGISTRY_PATH_MAX_LENGTH
    || isFilesystemRoot(absolutePath)
  ) {
    throw new AssistantRegistryUnavailableError();
  }
  const targetName = path.basename(absolutePath);
  if (!targetName || targetName === '.' || targetName === '..') {
    throw new AssistantRegistryUnavailableError();
  }

  const parentPath = path.dirname(absolutePath);
  const canonicalParentPath = await fs.realpath(parentPath);
  const parentStats = await fs.stat(canonicalParentPath);
  if (!parentStats.isDirectory() || isFilesystemRoot(
    path.join(canonicalParentPath, targetName)
  )) {
    throw new AssistantRegistryUnavailableError();
  }

  return {
    absolutePath,
    canonicalParentPath,
    canonicalTargetPath: path.join(canonicalParentPath, targetName),
  };
}

async function assertRegularRegistryTargetIfPresent(
  targetPath: string
): Promise<boolean> {
  try {
    const stats = await fs.lstat(targetPath);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new AssistantRegistryUnavailableError();
    }
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

async function readBoundedRegistryFile(
  targetPath: string
): Promise<string | null> {
  let beforePathStats: BigIntStats;
  try {
    beforePathStats = await fs.lstat(targetPath, { bigint: true });
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
  if (
    beforePathStats.isSymbolicLink()
    || !beforePathStats.isFile()
    || beforePathStats.size <= 0n
    || beforePathStats.size > BigInt(ASSISTANT_REGISTRY_MAX_BYTES)
  ) {
    throw new AssistantRegistryUnavailableError();
  }

  const noFollowFlag = process.platform === 'win32'
    ? 0
    : fsConstants.O_NOFOLLOW;
  const handle = await fs.open(
    targetPath,
    fsConstants.O_RDONLY | noFollowFlag
  );
  try {
    const openedFileStats = await handle.stat({ bigint: true });
    if (
      !openedFileStats.isFile()
      || !sameFileIdentity(beforePathStats, openedFileStats)
      || beforePathStats.size !== openedFileStats.size
      || beforePathStats.mtimeNs !== openedFileStats.mtimeNs
    ) {
      throw new AssistantRegistryUnavailableError();
    }
    const content = Buffer.allocUnsafe(Number(openedFileStats.size));
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(
        content,
        offset,
        content.length - offset,
        offset
      );
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== content.length) {
      throw new AssistantRegistryUnavailableError();
    }

    const afterHandleStats = await handle.stat({ bigint: true });
    const afterPathStats = await fs.lstat(targetPath, { bigint: true });
    const afterCanonicalPath = await fs.realpath(targetPath);
    if (
      !afterHandleStats.isFile()
      || afterPathStats.isSymbolicLink()
      || !afterPathStats.isFile()
      || !sameFileIdentity(openedFileStats, afterHandleStats)
      || !sameFileIdentity(openedFileStats, afterPathStats)
      || openedFileStats.size !== afterHandleStats.size
      || openedFileStats.size !== afterPathStats.size
      || openedFileStats.mtimeNs !== afterHandleStats.mtimeNs
      || openedFileStats.mtimeNs !== afterPathStats.mtimeNs
      || !sameResolvedPath(targetPath, afterCanonicalPath)
    ) {
      throw new AssistantRegistryUnavailableError();
    }
    return content.toString('utf8');
  } finally {
    await handle.close();
  }
}

function isJsonSafeAssistantTools(value: unknown): boolean {
  const pending: Array<{ depth: number; value: unknown }> = [{
    depth: 0,
    value,
  }];
  const visited = new WeakSet<object>();
  let nodeCount = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) {
      continue;
    }
    nodeCount += 1;
    if (
      nodeCount > ASSISTANT_TOOLS_MAX_NODES
      || current.depth > ASSISTANT_TOOLS_MAX_DEPTH
    ) {
      return false;
    }
    if (
      current.value === null
      || typeof current.value === 'string'
      || typeof current.value === 'boolean'
    ) {
      continue;
    }
    if (typeof current.value === 'number') {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value !== 'object') {
      return false;
    }
    if (visited.has(current.value)) {
      return false;
    }
    visited.add(current.value);

    if (Array.isArray(current.value)) {
      if (Object.getPrototypeOf(current.value) !== Array.prototype) {
        return false;
      }
      const lengthDescriptor = Object.getOwnPropertyDescriptor(
        current.value,
        'length'
      );
      if (
        !lengthDescriptor
        || !('value' in lengthDescriptor)
        || typeof lengthDescriptor.value !== 'number'
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.value > ASSISTANT_TOOLS_MAX_NODES
        || Reflect.ownKeys(current.value).length !== lengthDescriptor.value + 1
      ) {
        return false;
      }
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(
          current.value,
          String(index)
        );
        if (!descriptor || !('value' in descriptor)) {
          return false;
        }
        pending.push({
          depth: current.depth + 1,
          value: descriptor.value,
        });
      }
      continue;
    }

    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      return false;
    }
    const keys = Object.keys(current.value);
    if (Reflect.ownKeys(current.value).length !== keys.length) {
      return false;
    }
    for (const key of keys) {
      if (
        key.length === 0
        || key.length > 256
        || /[\u0000-\u001F\u007F]/u.test(key)
      ) {
        return false;
      }
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
      if (!descriptor || !('value' in descriptor)) {
        return false;
      }
      pending.push({
        depth: current.depth + 1,
        value: descriptor.value,
      });
    }
  }

  return true;
}

function validateLoadedAssistantRegistry(
  value: unknown
): AssistantRegistry {
  try {
    const validatedEntries = validateAssistantRegistryCandidate(value).map(
      ([key, record]): [string, AssistantRecord] => [
        key,
        {
          ...record,
          tools: record.tools as
            OpenAI.Beta.Assistants.Assistant['tools'] | null
        }
      ]
    );
    return createRegistry(validatedEntries);
  } catch {
    throw new AssistantRegistryUnavailableError();
  }
}

async function readAssistantRegistryFromDisk(
  target: ResolvedRegistryTarget
): Promise<AssistantRegistry | null> {
  const content = await readBoundedRegistryFile(target.canonicalTargetPath);
  if (content === null) {
    return null;
  }
  const parsed: unknown = JSON.parse(content);
  const registry = validateLoadedAssistantRegistry(parsed);
  assertProtectedConfigIntegrity('assistant_registry', parsed, {
    source: target.absolutePath,
  });
  return registry;
}

async function syncParentDirectory(canonicalParentPath: string): Promise<void> {
  if (process.platform === 'win32') {
    return;
  }
  const directoryHandle = await fs.open(canonicalParentPath, 'r');
  try {
    await directoryHandle.sync();
  } finally {
    await directoryHandle.close();
  }
}

async function writeAssistantRegistryAtomically(
  target: ResolvedRegistryTarget,
  registry: AssistantRegistry
): Promise<void> {
  const serialized = `${JSON.stringify(registry, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > ASSISTANT_REGISTRY_MAX_BYTES) {
    throw new AssistantRegistryUnavailableError();
  }

  await assertRegularRegistryTargetIfPresent(target.canonicalTargetPath);
  const temporaryPath = path.join(
    target.canonicalParentPath,
    `.${path.basename(target.canonicalTargetPath)}.${process.pid}.${randomUUID()}.tmp`
  );
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let temporaryFileExists = false;
  try {
    handle = await fs.open(temporaryPath, 'wx', 0o600);
    temporaryFileExists = true;
    await handle.writeFile(serialized, { encoding: 'utf8' });
    await handle.sync();
    await handle.close();
    handle = null;

    await assertRegularRegistryTargetIfPresent(target.canonicalTargetPath);
    await fs.rename(temporaryPath, target.canonicalTargetPath);
    temporaryFileExists = false;
    try {
      await syncParentDirectory(target.canonicalParentPath);
    } catch {
      safeAssistantRegistryWarn(
        '[AI-ASSISTANT-SYNC] Registry directory sync unavailable',
        LOG_CONTEXT,
        { failureCode: 'directory_sync_unavailable' }
      );
    }
  } finally {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    if (temporaryFileExists) {
      await fs.unlink(temporaryPath).catch(() => undefined);
    }
  }
}

function readBoundedString(
  value: unknown,
  maximumLength: number,
  allowNull: boolean,
  allowLineFormatting = false
): string | null {
  if (allowNull && value === null) {
    return null;
  }
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length > maximumLength
    || (
      allowLineFormatting
        ? /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value)
        : /[\u0000-\u001F\u007F]/u.test(value)
    )
  ) {
    throw new AssistantRegistrySyncError();
  }
  return value;
}

function validateAssistantEntry(value: unknown): AssistantInfo {
  if (!isRecord(value)) {
    throw new AssistantRegistrySyncError();
  }
  const id = readBoundedString(value.id, ASSISTANT_ID_MAX_LENGTH, false);
  const name = value.name === null
    ? null
    : readBoundedString(value.name, ASSISTANT_NAME_MAX_LENGTH, false);
  const instructions = value.instructions === null
    ? null
    : readBoundedString(
      value.instructions,
      ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
      false,
      true
    );
  const model = value.model === null
    ? null
    : readBoundedString(value.model, ASSISTANT_MODEL_MAX_LENGTH, false);
  const tools = value.tools;
  if (
    (tools !== null && !Array.isArray(tools))
    || !isJsonSafeAssistantTools(tools)
  ) {
    throw new AssistantRegistrySyncError();
  }

  let toolsJson: string;
  try {
    toolsJson = JSON.stringify(tools);
  } catch {
    throw new AssistantRegistrySyncError();
  }
  if (
    typeof toolsJson !== 'string'
    || Buffer.byteLength(toolsJson, 'utf8') > ASSISTANT_TOOLS_MAX_BYTES
  ) {
    throw new AssistantRegistrySyncError();
  }
  const canonicalTools = JSON.parse(toolsJson) as
    OpenAI.Beta.Assistants.Assistant['tools'] | null;

  const assistant = {
    id: id as string,
    name,
    instructions,
    tools: canonicalTools,
    model,
  };
  if (
    Buffer.byteLength(JSON.stringify(assistant), 'utf8')
    > ASSISTANT_RECORD_MAX_BYTES
  ) {
    throw new AssistantRegistrySyncError();
  }
  return assistant;
}

async function getAllAssistantsForConfirmedSync(): Promise<AssistantInfo[]> {
  const { client } = requireOpenAIClientOrAdapter(
    'OpenAI adapter not initialized'
  );
  const assistants: AssistantInfo[] = [];
  const seenAssistantIds = new Set<string>();
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (let pageNumber = 0; pageNumber < ASSISTANT_LIST_MAX_PAGES; pageNumber += 1) {
    const response = await client.beta.assistants.list({
      limit: ASSISTANT_LIST_PAGE_LIMIT,
      after: cursor,
    }) as AssistantListPage;
    if (
      !isRecord(response)
      || !Array.isArray(response.data)
      || typeof response.has_more !== 'boolean'
      || response.data.length > ASSISTANT_LIST_PAGE_LIMIT
    ) {
      throw new AssistantRegistrySyncError();
    }

    for (const rawAssistant of response.data) {
      if (assistants.length >= ASSISTANT_LIST_MAX_RECORDS) {
        throw new AssistantRegistrySyncError();
      }
      const assistant = validateAssistantEntry(rawAssistant);
      if (seenAssistantIds.has(assistant.id)) {
        throw new AssistantRegistrySyncError();
      }
      seenAssistantIds.add(assistant.id);
      assistants.push(assistant);
    }

    if (!response.has_more) {
      return assistants;
    }
    if (
      pageNumber + 1 >= ASSISTANT_LIST_MAX_PAGES
      || response.data.length === 0
    ) {
      throw new AssistantRegistrySyncError();
    }

    const lastId = readBoundedString(
      (response as { last_id?: unknown }).last_id,
      ASSISTANT_ID_MAX_LENGTH,
      false
    ) as string;
    if (
      lastId === cursor
      || seenCursors.has(lastId)
      || assistants.at(-1)?.id !== lastId
    ) {
      throw new AssistantRegistrySyncError();
    }
    seenCursors.add(lastId);
    cursor = lastId;
  }

  throw new AssistantRegistrySyncError();
}

function mapAssistantsToRegistry(
  assistants: readonly AssistantInfo[]
): AssistantRegistry {
  const entries: Array<[string, AssistantRecord]> = [];
  const normalizedNames = new Set<string>();
  for (const assistant of assistants) {
    if (!assistant.name) {
      continue;
    }
    const normalizedName = normalizeAssistantName(assistant.name);
    if (!normalizedName || normalizedNames.has(normalizedName)) {
      throw new AssistantRegistrySyncError();
    }
    normalizedNames.add(normalizedName);
    entries.push([
      normalizedName,
      {
        ...assistant,
        normalizedName,
      },
    ]);
  }
  entries.sort(([left], [right]) => compareStrings(left, right));
  return createRegistry(entries);
}

function registriesEqual(
  left: AssistantRegistry,
  right: AssistantRegistry
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export async function loadAssistantRegistry(): Promise<AssistantRegistry> {
  return runSerializedRegistryOperation(async () => {
    let target: ResolvedRegistryTarget;
    try {
      target = await resolveRegistryTarget();
      const registry = await readAssistantRegistryFromDisk(target);
      if (registry) {
        liveRegistry = cloneRegistry(registry);
        return cloneRegistry(registry);
      }
      if (liveRegistry) {
        return cloneRegistry(liveRegistry);
      }
      return createRegistry();
    } catch {
      safeAssistantRegistryWarn(
        '[AI-ASSISTANT-SYNC] Registry read rejected',
        LOG_CONTEXT,
        { failureCode: 'registry_unavailable' }
      );
      if (liveRegistry) {
        return cloneRegistry(liveRegistry);
      }
      throw new AssistantRegistryUnavailableError();
    }
  });
}

export async function getAssistantRegistry(): Promise<AssistantRegistry> {
  return loadAssistantRegistry();
}

export async function getAssistantNames(): Promise<string[]> {
  const registry = await getAssistantRegistry();
  return Object.keys(registry).sort(compareStrings);
}

export async function getAssistant(
  name: string
): Promise<AssistantRecord | undefined> {
  if (
    typeof name !== 'string'
    || name.length === 0
    || name.length > ASSISTANT_NAME_MAX_LENGTH
    || /[\u0000-\u001F\u007F]/u.test(name)
  ) {
    return undefined;
  }
  const registry = await getAssistantRegistry();
  const exactRecord = getOwnAssistantRecord(registry, name);
  if (exactRecord) {
    return structuredClone(exactRecord);
  }

  const normalized = normalizeAssistantName(name);
  const normalizedRecord = normalized
    ? getOwnAssistantRecord(registry, normalized)
    : undefined;
  if (normalizedRecord) {
    return structuredClone(normalizedRecord);
  }

  const lowerName = name.toLowerCase();
  const record = Object.values(registry).find(
    (entry) => entry.name?.toLowerCase() === lowerName
  );
  return record ? structuredClone(record) : undefined;
}

export async function buildAssistantLookup(): Promise<Record<string, string>> {
  const registry = await getAssistantRegistry();
  const lookup = Object.create(null) as Record<string, string>;
  for (const record of Object.values(registry)) {
    if (record.name) {
      lookup[record.name.toLowerCase()] = record.id;
    }
    lookup[record.normalizedName.toLowerCase()] = record.id;
  }
  return lookup;
}

async function performAssistantRegistrySync(): Promise<
  AssistantRegistrySyncResult
> {
  const assistants = await getAllAssistantsForConfirmedSync();
  const candidateRegistry = mapAssistantsToRegistry(assistants);

  return runSerializedRegistryOperation(async () => {
    const target = await resolveRegistryTarget();
    let previousRegistry = liveRegistry
      ? cloneRegistry(liveRegistry)
      : createRegistry();
    let persistedRegistryValid = false;
    try {
      const persistedRegistry = await readAssistantRegistryFromDisk(target);
      if (persistedRegistry) {
        previousRegistry = persistedRegistry;
        liveRegistry = cloneRegistry(persistedRegistry);
        persistedRegistryValid = true;
      }
    } catch {
      // A confirmed, fully fetched candidate may repair an invalid cache. The
      // existing live snapshot remains untouched until atomic replacement.
    }

    if (
      persistedRegistryValid
      && registriesEqual(previousRegistry, candidateRegistry)
    ) {
      return {
        changed: false,
        registry: cloneRegistry(previousRegistry),
      };
    }

    const preparedIntegrityUpdate = prepareAssistantRegistryIntegrityUpdate(
      candidateRegistry,
      { source: target.absolutePath }
    );
    await writeAssistantRegistryAtomically(target, candidateRegistry);
    liveRegistry = cloneRegistry(candidateRegistry);
    try {
      preparedIntegrityUpdate.commit();
    } catch {
      safeAssistantRegistryWarn(
        '[AI-ASSISTANT-SYNC] Post-install integrity reporting failed',
        LOG_CONTEXT,
        { failureCode: 'integrity_reporting_failed' }
      );
    }
    return {
      changed: true,
      registry: cloneRegistry(candidateRegistry),
    };
  });
}

export async function syncAssistantRegistry(): Promise<
  AssistantRegistrySyncResult
> {
  if (assistantRegistrySyncActive) {
    throw new AssistantRegistrySyncInProgressError();
  }
  assistantRegistrySyncActive = true;
  const context = { ...LOG_CONTEXT, operation: 'sync' };
  const endTimer = startAssistantRegistryTimer(context);
  try {
    const result = await performAssistantRegistrySync();
    safeAssistantRegistryInfo(
      '[AI-ASSISTANT-SYNC] Registry synchronized',
      context,
      {
      changed: result.changed,
      count: Object.keys(result.registry).length,
      }
    );
    return result;
  } catch {
    safeAssistantRegistryError(
      '[AI-ASSISTANT-SYNC] Synchronization failed',
      context,
      {
        failureCode: 'assistant_registry_sync_failed',
      }
    );
    throw new AssistantRegistrySyncError();
  } finally {
    assistantRegistrySyncActive = false;
    endTimer();
  }
}

/**
 * Call an assistant by its name with a single message.
 *
 * A miss is local and never performs an implicit provider registry refresh.
 * Operators must synchronize explicitly through the confirmed HTTP endpoint.
 */
export async function callAssistantByName(name: string, message: string) {
  const normalized = normalizeAssistantName(name);
  const registry = await getAssistantRegistry();

  let assistantId = normalized ? registry[normalized]?.id : undefined;
  if (!assistantId) {
    const lowerName = name.toLowerCase();
    for (const record of Object.values(registry)) {
      if (record.name?.toLowerCase() === lowerName) {
        assistantId = record.id;
        break;
      }
    }
  }
  if (!assistantId) {
    throw new Error('Assistant not found.');
  }

  const { client } = requireOpenAIClientOrAdapter(
    'OpenAI adapter not initialized'
  );
  const thread = await client.beta.threads.create({
    messages: [{ role: 'user', content: message }],
  });
  return client.beta.threads.runs.create(thread.id, {
    assistant_id: assistantId,
  });
}

export const openAIAssistantsService = {
  buildAssistantLookup,
  callAssistantByName,
  normalizeAssistantName,
  getAssistantRegistry,
  getAssistantNames,
  getAssistant,
  syncAssistantRegistry,
};

export default openAIAssistantsService;
