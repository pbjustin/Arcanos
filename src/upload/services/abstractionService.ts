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

  const isAllowed = ALLOWED_BASE_DIRS.some(
    (base) => resolved.startsWith(base + path.sep) || resolved === base
  );

  if (!isAllowed) {
    throw new UploadError("Path is outside allowed directories", 403);
  }

  return resolved;
}

export async function routeAbstractUpload(
  descriptor: UploadDescriptor
) {
  if (descriptor.type === "local") {
    const safePath = validateLocalPath(descriptor.path);
    const outputDir = path.join(config.UPLOAD_ROOT, `abstract-${uuid()}`);
    return extractZip(safePath, outputDir);
  }

  throw new UploadError(`Unsupported upload type: ${descriptor.type}`, 400);
}
