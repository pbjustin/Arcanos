import fs from 'fs/promises';
import path from 'path';

export async function getFileLineCount(basePath: string, file: string): Promise<number> {
  const content = await fs.readFile(path.join(basePath, file), 'utf-8');
  return content.split('\n').length;
}

export function collectMatches(diff: string, pattern: RegExp): string[] {
  return diff.match(pattern) || [];
}

export function hasLongFunctionAddition(longFunctions: string[], threshold: number): boolean {
  return longFunctions.some(fn => fn.split('\n').length > threshold);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
