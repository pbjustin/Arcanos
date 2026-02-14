import { Request } from "express";
import Busboy from "busboy";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { fileTypeFromFile } from "file-type";
import { config } from "../config/index.js";
import { extractZip } from "./extractor.js";
import { ensureDir } from "../utils/ensureDir.js";
import { UploadResult, UploadError } from "../types/upload.js";

export function handleUpload(req: Request): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const uploadId = uuid();
    const uploadDir = path.join(config.UPLOAD_ROOT, uploadId);

    ensureDir(uploadDir).then(() => {
      const zipPath = path.join(uploadDir, "original.zip");

      const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: config.MAX_FILE_SIZE, files: 1 }
      });

      let uploaded = false;
      let writeStreamDone: Promise<void> | null = null;

      busboy.on("file", (field, file) => {
        uploaded = true;

        const writeStream = fs.createWriteStream(zipPath);

        // Create a promise that resolves when the write stream finishes flushing
        writeStreamDone = new Promise<void>((resolveWrite, rejectWrite) => {
          writeStream.on("finish", resolveWrite);
          writeStream.on("error", rejectWrite);
        });

        file.on("limit", () => {
          writeStream.destroy();
          reject(new UploadError("File size limit exceeded", 413));
        });

        file.on("error", (err) => {
          writeStream.destroy();
          reject(err);
        });

        file.pipe(writeStream);
      });

      busboy.on("finish", async () => {
        if (!uploaded) return reject(new UploadError("No file uploaded", 400));

        try {
          // Wait for the write stream to fully flush before reading the file.
          // busboy "finish" fires when parsing completes, but the piped write
          // stream may still be draining to disk.
          if (writeStreamDone) {
            await writeStreamDone;
          }

          // Verify file actually exists and has content
          const stat = await fsPromises.stat(zipPath);
          if (stat.size === 0) {
            throw new UploadError("Uploaded file is empty", 400);
          }

          const type = await fileTypeFromFile(zipPath);
          if (!type || type.mime !== "application/zip") {
            throw new UploadError(
              `Invalid file type: expected application/zip, got ${type?.mime ?? "unknown"}`,
              400
            );
          }

          const extracted = await extractZip(zipPath, uploadDir);

          resolve({
            uploadId,
            extractedFiles: extracted
          });
        } catch (err) {
          // Cleanup the upload directory on any processing failure
          await fsPromises.rm(uploadDir, { recursive: true, force: true }).catch(() => {});
          reject(err);
        }
      });

      busboy.on("error", reject);

      req.pipe(busboy);
    }).catch(reject);
  });
}
