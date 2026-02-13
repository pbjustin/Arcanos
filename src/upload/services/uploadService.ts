import { Request } from "express";
import Busboy from "busboy";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { fileTypeFromFile } from "file-type";
import { config } from "../config/index.js";
import { extractZip } from "./extractor.js";
import { ensureDir } from "../utils/ensureDir.js";
import { UploadResult } from "../types/upload.js";

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

      busboy.on("file", (field, file) => {
        uploaded = true;

        const writeStream = fs.createWriteStream(zipPath);

        file.on("limit", () =>
          reject(new Error("File size limit exceeded"))
        );

        file.on("error", reject);
        writeStream.on("error", reject);

        file.pipe(writeStream);
      });

      busboy.on("finish", async () => {
        if (!uploaded) return reject(new Error("No file uploaded"));

        try {
          const type = await fileTypeFromFile(zipPath);
          if (!type || type.mime !== "application/zip") {
            throw new Error("Invalid MIME type");
          }

          const extracted = await extractZip(zipPath, uploadDir);

          resolve({
            uploadId,
            extractedFiles: extracted
          });
        } catch (err) {
          reject(err);
        }
      });

      busboy.on("error", reject);

      req.pipe(busboy);
    }).catch(reject);
  });
}
