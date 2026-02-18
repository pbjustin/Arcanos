import { promises as fs } from "fs";

/**
 * Purpose: Ensure a directory exists before write operations execute.
 * Inputs/Outputs: Accepts a directory path and resolves when the directory is present.
 * Edge cases: Existing directories are treated as success via recursive mkdir idempotency.
 */
export async function ensureDir(dir: string): Promise<void> {
  //audit Assumption: directory creation may be called concurrently by retries.
  //audit Failure risk: non-idempotent creation would race and throw EEXIST.
  //audit Invariant: directory exists after resolution.
  //audit Handling: `recursive: true` makes repeated calls safe.
  await fs.mkdir(dir, { recursive: true });
}
