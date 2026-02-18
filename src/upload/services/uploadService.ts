import Busboy from "busboy";
import { Request } from "express";
import { promises as fsPromises } from "fs";
import fs from "fs";
import path from "path";
import { fileTypeFromFile } from "file-type";
import { v4 as uuid } from "uuid";
import { config } from "../config/index.js";
import { UploadError, UploadResult } from "../types/upload.js";
import { ensureDir } from "../utils/ensureDir.js";
import { logger } from "../utils/logger.js";
import { cleanupUploadArtifacts } from "./cleanupService.js";
import { scanFileWithClamav } from "./clamavService.js";
import { extractZip } from "./extractor.js";

function normalizeUploadError(error: unknown): UploadError {
  if (error instanceof UploadError) {
    return error;
  }

  return new UploadError("Upload processing failed", 500, "UPLOAD_STREAM_FAILED", {
    cause: error,
  });
}

/**
 * Purpose: Persist an incoming multipart upload to disk as a single zip artifact.
 * Inputs/Outputs: Accepts Express request and destination zip path; resolves after file is fully flushed.
 * Edge cases: No file, oversized file, request abort, or stream errors reject with UploadError.
 */
async function persistMultipartUpload(req: Request, zipPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const busboy = Busboy({
      headers: req.headers,
      limits: { fileSize: config.MAX_FILE_SIZE, files: 1 },
    });
    let uploadReceived = false;
    let settled = false;
    let writeCompletionPromise: Promise<void> | null = null;
    let currentFileStream: NodeJS.ReadableStream | null = null;
    let currentWriteStream: fs.WriteStream | null = null;

    const settleWithError = (error: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      if (writeCompletionPromise) {
        void writeCompletionPromise.catch((writeError) => {
          logger.warn(
            { writeError },
            "Upload write stream settled after request failure"
          );
        });
      }
      currentFileStream?.unpipe(currentWriteStream ?? undefined);
      currentFileStream?.resume();
      currentWriteStream?.destroy();
      reject(normalizeUploadError(error));
    };

    const settleWithSuccess = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve();
    };

    busboy.on("file", (fieldName, fileStream) => {
      //audit Assumption: endpoint contract allows exactly one file per upload request.
      //audit Failure risk: multiple files could bypass size/accounting controls.
      //audit Invariant: only first file stream is processed and persisted.
      //audit Handling: reject and short-circuit if a second file is encountered.
      if (uploadReceived) {
        fileStream.resume();
        settleWithError(
          new UploadError(
            "Only one file upload is supported",
            400,
            "UPLOAD_VALIDATION_FAILED",
            { details: { fieldName } }
          )
        );
        return;
      }

      uploadReceived = true;
      currentFileStream = fileStream;
      currentWriteStream = fs.createWriteStream(zipPath, { flags: "wx" });
      writeCompletionPromise = new Promise<void>((resolveWrite, rejectWrite) => {
        currentWriteStream?.on("finish", resolveWrite);
        currentWriteStream?.on("error", rejectWrite);
      });

      fileStream.on("limit", () => {
        settleWithError(
          new UploadError("File size limit exceeded", 413, "UPLOAD_TOO_LARGE", {
            details: { maxFileSize: config.MAX_FILE_SIZE },
          })
        );
      });

      fileStream.on("error", (streamError) => {
        settleWithError(
          new UploadError("Upload file stream failed", 400, "UPLOAD_STREAM_FAILED", {
            cause: streamError,
            details: { fieldName },
          })
        );
      });

      fileStream.pipe(currentWriteStream);
    });

    busboy.on("finish", async () => {
      //audit Assumption: multipart parser can finish without seeing a file field.
      //audit Failure risk: empty upload requests would otherwise proceed with missing archive path.
      //audit Invariant: zip persistence only completes when a file was actually streamed.
      //audit Handling: reject when no file was received.
      if (!uploadReceived) {
        settleWithError(new UploadError("No file uploaded", 400, "UPLOAD_VALIDATION_FAILED"));
        return;
      }

      if (writeCompletionPromise) {
        try {
          await writeCompletionPromise;
        } catch (writeError) {
          settleWithError(
            new UploadError("Failed to flush upload to disk", 500, "UPLOAD_STREAM_FAILED", {
              cause: writeError,
            })
          );
          return;
        }
      }

      settleWithSuccess();
    });

    busboy.on("error", (parserError) => {
      settleWithError(
        new UploadError("Failed to parse multipart upload", 400, "UPLOAD_STREAM_FAILED", {
          cause: parserError,
        })
      );
    });

    req.on("aborted", () => {
      settleWithError(new UploadError("Upload aborted by client", 400, "UPLOAD_ABORTED"));
    });

    req.on("error", (requestError) => {
      settleWithError(
        new UploadError("Upload request stream failed", 400, "UPLOAD_STREAM_FAILED", {
          cause: requestError,
        })
      );
    });

    req.pipe(busboy);
  });
}

/**
 * Purpose: Validate uploaded artifact is a non-empty zip file.
 * Inputs/Outputs: Accepts zip path and resolves when validation passes.
 * Edge cases: Missing file, zero-byte file, and non-zip MIME signatures are rejected.
 */
async function validateUploadedZipArtifact(zipPath: string): Promise<void> {
  const uploadedFileStats = await fsPromises.stat(zipPath).catch((statError) => {
    throw new UploadError("Uploaded file not found", 400, "UPLOAD_VALIDATION_FAILED", {
      cause: statError,
    });
  });

  //audit Assumption: successful upload must persist at least one byte to disk.
  //audit Failure risk: empty files can pass parser checks but break downstream extraction.
  //audit Invariant: extractor receives non-empty archive input.
  //audit Handling: hard-fail validation if archive size is zero.
  if (uploadedFileStats.size <= 0) {
    throw new UploadError("Uploaded file is empty", 400, "UPLOAD_VALIDATION_FAILED");
  }

  const detectedFileType = await fileTypeFromFile(zipPath);

  //audit Assumption: trusted uploads must have ZIP signature, not only `.zip` extension.
  //audit Failure risk: disguised binaries could execute extraction exploit paths.
  //audit Invariant: accepted payload MIME equals `application/zip`.
  //audit Handling: reject uploads with unknown or mismatched MIME signatures.
  if (!detectedFileType || detectedFileType.mime !== "application/zip") {
    throw new UploadError("Invalid MIME type", 400, "UPLOAD_INVALID_MIME", {
      details: { detectedMime: detectedFileType?.mime ?? "unknown" },
    });
  }
}

/**
 * Purpose: Enforce malware scanning policy for uploaded zip archives.
 * Inputs/Outputs: Accepts zip path and resolves when policy permits continued processing.
 * Edge cases: Scanner downtime fails closed by default unless `CLAMAV_FAIL_OPEN=true`.
 */
async function enforceMalwareScanPolicy(zipPath: string): Promise<void> {
  if (!config.ENABLE_CLAMAV) {
    return;
  }

  const scanResult = await scanFileWithClamav(zipPath);

  //audit Assumption: infected status is authoritative and must block processing.
  //audit Failure risk: processing infected archives can compromise downstream hosts.
  //audit Invariant: infected uploads never reach extraction.
  //audit Handling: throw structured security error with signature context.
  if (scanResult.status === "infected") {
    throw new UploadError("Malware detected in uploaded archive", 422, "UPLOAD_MALWARE_DETECTED", {
      details: {
        signature: scanResult.signature ?? "unknown",
      },
    });
  }

  //audit Assumption: scanner availability can fluctuate in distributed environments.
  //audit Failure risk: implicit fail-open could admit unscanned malicious archives.
  //audit Invariant: unavailable scanner is either explicitly fail-open or hard-failed.
  //audit Handling: honor `CLAMAV_FAIL_OPEN`, otherwise reject request.
  if (scanResult.status === "unavailable") {
    if (config.CLAMAV_FAIL_OPEN) {
      logger.warn(
        { rawResponse: scanResult.rawResponse },
        "ClamAV unavailable; continuing due to fail-open policy"
      );
      return;
    }

    throw new UploadError(
      "Malware scanner unavailable",
      503,
      "UPLOAD_SCANNER_UNAVAILABLE",
      { details: { rawResponse: scanResult.rawResponse ?? "unknown" } }
    );
  }
}

/**
 * Purpose: Handle end-to-end zip upload flow with validation, scan, extraction, and rollback.
 * Inputs/Outputs: Accepts Express request and returns upload id plus extracted file paths.
 * Edge cases: Any failure triggers idempotent artifact cleanup before error propagation.
 */
export async function handleUpload(req: Request): Promise<UploadResult> {
  const uploadId = uuid();
  const uploadDirectory = path.join(config.UPLOAD_ROOT, uploadId);
  const zipPath = path.join(uploadDirectory, "original.zip");

  await ensureDir(uploadDirectory);

  try {
    await persistMultipartUpload(req, zipPath);
    await validateUploadedZipArtifact(zipPath);
    await enforceMalwareScanPolicy(zipPath);
    const extractedFiles = await extractZip(zipPath, uploadDirectory);

    return {
      uploadId,
      extractedFiles,
    };
  } catch (uploadError) {
    const cleanupSummary = await cleanupUploadArtifacts(uploadDirectory);
    if (cleanupSummary.failures.length > 0) {
      logger.error(
        { failures: cleanupSummary.failures, uploadDirectory },
        "Upload rollback encountered cleanup failures"
      );
    }

    throw normalizeUploadError(uploadError);
  }
}
