import fs from 'fs/promises';
import path from 'path';

/**
 * Purpose: Count total lines in a file for size-based checks.
 * Inputs/Outputs: basePath + file path; returns number of newline-separated lines.
 * Edge cases: Throws when the file cannot be read.
 */
export async function getFileLineCount(basePath: string, file: string): Promise<number> {
  const content = await fs.readFile(path.join(basePath, file), 'utf-8');
  return content.split('\n').length;
}

/**
 * Purpose: Extract regex matches from a diff for analysis.
 * Inputs/Outputs: diff string + pattern; returns array of matches or empty array.
 * Edge cases: No matches returns empty array.
 */
export function collectMatches(diff: string, pattern: RegExp): string[] {
  return diff.match(pattern) || [];
}

/**
 * Purpose: Detect whether any function addition exceeds the line threshold.
 * Inputs/Outputs: longFunctions list + threshold; returns true if any exceed threshold.
 * Edge cases: Empty list returns false.
 */
export function hasLongFunctionAddition(longFunctions: string[], threshold: number): boolean {
  return longFunctions.some(fn => fn.split('\n').length > threshold);
}

/**
 * Purpose: Normalize a list of strings to unique values.
 * Inputs/Outputs: string list; returns de-duplicated list.
 * Edge cases: Empty list returns empty list.
 */
export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Purpose: Convert camelCase check keys into human-readable labels.
 * Inputs/Outputs: check key string; returns spaced label.
 * Edge cases: Non-camelCase strings return unchanged.
 */
export function formatCheckLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2');
}
