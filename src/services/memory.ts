import { promises as fs } from 'fs';
import path from 'path';
import {
  createVersionedMemoryEnvelope,
  unwrapVersionedMemoryEnvelope
} from './safety/memoryEnvelope.js';

const MEMORY_ROOT = path.resolve('memory');

export interface MemoryWriteOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
}

function createMemoryAbortError(message: string): Error {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function throwIfMemoryWriteCancelled(options: MemoryWriteOptions): void {
  if (options.signal?.aborted) {
    throw options.signal.reason instanceof Error
      ? options.signal.reason
      : createMemoryAbortError('memory write aborted');
  }

  if (typeof options.deadlineAt === 'number' && Date.now() >= options.deadlineAt) {
    throw createMemoryAbortError('memory write deadline exceeded');
  }
}

function sanitizeSegment(segment: string): string {
  return segment
    .replace(/\.\.+/g, '')
    .replace(/[<>:"|?*]/g, '')
    .replace(/[\\]/g, '-')
    .trim() || 'entry';
}

function resolveMemoryPath(key: string): string {
  const segments = key
    .split('/')
    .map(segment => segment.trim())
    .filter(Boolean)
    .map(sanitizeSegment);

  const filePath = path.join(MEMORY_ROOT, ...segments) + '.json';
  return filePath;
}

async function ensureDirectory(filePath: string, options: MemoryWriteOptions): Promise<void> {
  const dir = path.dirname(filePath);
  throwIfMemoryWriteCancelled(options);
  await fs.mkdir(dir, { recursive: true });
  throwIfMemoryWriteCancelled(options);
}

export async function setMemory(
  key: string,
  value: unknown,
  options: MemoryWriteOptions = {}
): Promise<void> {
  throwIfMemoryWriteCancelled(options);
  const filePath = resolveMemoryPath(key);
  await ensureDirectory(filePath, options);
  throwIfMemoryWriteCancelled(options);
  const envelope = createVersionedMemoryEnvelope(value, {
    prefix: 'file-memory'
  });
  throwIfMemoryWriteCancelled(options);
  await fs.writeFile(filePath, JSON.stringify(envelope, null, 2), {
    encoding: 'utf-8',
    signal: options.signal
  });
  throwIfMemoryWriteCancelled(options);
}

export async function getMemory<T = unknown>(key: string): Promise<T | null> {
  const filePath = resolveMemoryPath(key);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    //audit Assumption: file-backed memory may contain legacy non-envelope payloads; risk: read regression; invariant: return plain payload for both shapes; handling: unwrap when envelope detected.
    return unwrapVersionedMemoryEnvelope<T>(parsed).payload;
  } catch (error: unknown) {
    //audit Assumption: missing files indicate no memory entry
    if (isNodeError(error) && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function deleteMemory(key: string): Promise<void> {
  const filePath = resolveMemoryPath(key);
  try {
    await fs.unlink(filePath);
  } catch (error: unknown) {
    //audit Assumption: missing file deletions are safe to ignore
    if (!isNodeError(error) || error.code !== 'ENOENT') {
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === 'object' && error !== null && 'code' in error;
}
