import { promises as fs } from 'fs';
import path from 'path';

const MEMORY_ROOT = path.resolve('memory');

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

async function ensureDirectory(filePath: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
}

export async function setMemory(key: string, value: unknown): Promise<void> {
  const filePath = resolveMemoryPath(key);
  await ensureDirectory(filePath);
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

export async function getMemory<T = any>(key: string): Promise<T | null> {
  const filePath = resolveMemoryPath(key);
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

export async function deleteMemory(key: string): Promise<void> {
  const filePath = resolveMemoryPath(key);
  try {
    await fs.unlink(filePath);
  } catch (error: any) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }
}
