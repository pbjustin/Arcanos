import path from "path";

export function guardZipSlip(baseDir: string, targetPath: string) {
  const resolvedBase = path.resolve(baseDir) + path.sep;
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedTarget.startsWith(resolvedBase)) {
    throw new Error("Zip Slip detected: path escapes output directory");
  }
}
