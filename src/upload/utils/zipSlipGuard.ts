import path from "path";

export function guardZipSlip(baseDir: string, targetPath: string) {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);

  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error("Zip Slip detected");
  }
}
