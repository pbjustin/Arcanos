import { UploadDescriptor } from "../types/upload.js";
import { extractZip } from "./extractor.js";

export async function routeAbstractUpload(
  descriptor: UploadDescriptor
) {
  if (descriptor.type === "local" && descriptor.path) {
    return extractZip(descriptor.path, "temp/abstract");
  }

  throw new Error("Unsupported upload descriptor");
}
