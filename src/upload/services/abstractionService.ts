import path from "path";
import { v4 as uuid } from "uuid";
import { UploadDescriptor, UploadError } from "../types/upload.js";
import { extractZip } from "./extractor.js";
import { config } from "../config/index.js";

const ALLOWED_BASE_DIRS = [
  path.resolve(config.UPLOAD_ROOT),
];

function validateLocalPath(filePath: string): string {
  const resolved = path.resolve(filePath);

  //audit Assumption: abstract uploads must only read archives from pre-approved roots.
  //audit Failure risk: unrestricted local paths can expose arbitrary host files.
  //audit Invariant: resolved path remains within allowed base directories.
  //audit Handling: reject with 403 when path escapes approved roots.
  const isAllowed = ALLOWED_BASE_DIRS.some(
    (base) => resolved.startsWith(base + path.sep) || resolved === base
  );

  if (!isAllowed) {
    throw new UploadError("Path is outside allowed directories", 403, "UPLOAD_UNSUPPORTED_DESCRIPTOR");
  }

  return resolved;
}

/**
 * Purpose: Route abstract upload descriptors to concrete archive extraction logic.
 * Inputs/Outputs: Accepts a descriptor and returns extracted file paths when supported.
 * Edge cases: Unsupported descriptor types and missing required fields are rejected.
 */
export async function routeAbstractUpload(
  descriptor: UploadDescriptor
) {
  //audit Assumption: descriptor can arrive from untrusted client JSON body.
  //audit Failure risk: missing local path can trigger undefined path resolution.
  //audit Invariant: local descriptors must include a path value.
  //audit Handling: validate descriptor fields before path resolution.
  if (descriptor.type === "local" && descriptor.path) {
    const safePath = validateLocalPath(descriptor.path);
    const outputDir = path.join(config.UPLOAD_ROOT, `abstract-${uuid()}`);
    return extractZip(safePath, outputDir);
  }

  throw new UploadError(
    `Unsupported upload descriptor: ${descriptor.type}`,
    400,
    "UPLOAD_UNSUPPORTED_DESCRIPTOR"
  );
}
