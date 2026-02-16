import path from "path";

/**
 * Purpose: Block zip entry paths that escape the extraction root.
 * Inputs/Outputs: Accepts an extraction base directory and candidate target path; throws on violation.
 * Edge cases: Relative path traversal (`../`) and absolute paths are rejected.
 */
export function guardZipSlip(baseDir: string, targetPath: string) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  //audit Assumption: path resolution canonicalizes traversal sequences.
  //audit Failure risk: unchecked extraction may overwrite arbitrary host files.
  //audit Invariant: destination remains under extraction root.
  //audit Handling: hard-fail with descriptive error to stop extraction.
  if (!resolvedTarget.startsWith(`${resolvedBase}${path.sep}`)) {
    throw new Error("Zip Slip detected");
  }
}
