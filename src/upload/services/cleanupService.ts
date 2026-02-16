import { promises as fs } from "fs";
import path from "path";
import { logger } from "../utils/logger.js";

export interface CleanupFailure {
  targetPath: string;
  error: unknown;
}

export interface CleanupSummary {
  removedPaths: string[];
  failures: CleanupFailure[];
}

/**
 * Purpose: Remove a path recursively in an idempotent way.
 * Inputs/Outputs: Accepts a file or directory path and resolves when removal attempt finishes.
 * Edge cases: Missing paths are treated as successful no-op deletions.
 */
export async function removePathRecursively(targetPath: string): Promise<void> {
  //audit Assumption: cleanup can be called multiple times for the same directory.
  //audit Failure risk: non-idempotent deletion could throw ENOENT during retries.
  //audit Invariant: target path does not exist after successful resolution.
  //audit Handling: force+recursive allows safe repeated cleanup attempts.
  await fs.rm(targetPath, { recursive: true, force: true });
}

/**
 * Purpose: Roll back upload artifacts after failed processing.
 * Inputs/Outputs: Accepts a root upload directory and optional extra paths; returns per-path cleanup results.
 * Edge cases: Duplicate paths are deduplicated to avoid redundant delete races.
 */
export async function cleanupUploadArtifacts(
  uploadDirectory: string,
  additionalPaths: string[] = []
): Promise<CleanupSummary> {
  const normalizedTargets = new Set<string>();
  normalizedTargets.add(path.resolve(uploadDirectory));

  for (const additionalPath of additionalPaths) {
    normalizedTargets.add(path.resolve(additionalPath));
  }

  const cleanupSummary: CleanupSummary = {
    removedPaths: [],
    failures: [],
  };

  for (const targetPath of normalizedTargets) {
    try {
      await removePathRecursively(targetPath);
      cleanupSummary.removedPaths.push(targetPath);
    } catch (cleanupError) {
      //audit Assumption: cleanup failures should not hide the original upload error.
      //audit Failure risk: leaked temp artifacts can accumulate sensitive data on disk.
      //audit Invariant: each cleanup failure is surfaced in structured logs/results.
      //audit Handling: record and log failure, then continue best-effort cleanup.
      cleanupSummary.failures.push({ targetPath, error: cleanupError });
      logger.error(
        { targetPath, error: cleanupError },
        "Upload artifact cleanup failed"
      );
    }
  }

  return cleanupSummary;
}
