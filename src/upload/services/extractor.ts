import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import yauzl from "yauzl";
import { config } from "../config/index.js";
import { UploadError } from "../types/upload.js";
import { logger } from "../utils/logger.js";
import { streamPipeline } from "../utils/streamPipeline.js";
import { guardZipSlip } from "../utils/zipSlipGuard.js";
import { createArchiveSizeGuardTransform } from "../utils/archiveSizeGuard.js";
import type { ArchiveSizeGuardState } from "../utils/archiveSizeGuard.js";
import { cleanupUploadArtifacts } from "./cleanupService.js";

const BLOCKED_EXTENSIONS = new Set([
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".com",
  ".scr",
  ".msi",
  ".ps1",
]);

function isDirectoryEntry(entryName: string): boolean {
  return /\/$/.test(entryName);
}

function normalizeEntryNameForExtensionCheck(entryName: string): string {
  const normalizedPathSeparators = entryName.replace(/\\/g, "/");
  const baseFileName = path.posix.basename(normalizedPathSeparators);
  return baseFileName.replace(/[. ]+$/g, "");
}

/**
 * Purpose: Determine whether an archive entry filename resolves to a blocked executable extension.
 * Inputs/Outputs: Accepts raw zip entry name and returns true when extension is blocked.
 * Edge cases: Trailing dots/spaces are stripped so names like `payload.exe.` remain blocked.
 */
export function isBlockedFile(entryName: string): boolean {
  const sanitizedName = normalizeEntryNameForExtensionCheck(entryName);
  return BLOCKED_EXTENSIONS.has(path.extname(sanitizedName).toLowerCase());
}

function toExtractionError(error: unknown): UploadError {
  if (error instanceof UploadError) {
    return error;
  }

  return new UploadError(
    "Zip extraction failed",
    400,
    "UPLOAD_EXTRACTION_FAILED",
    { cause: error }
  );
}

/**
 * Purpose: Securely extract a zip archive into an output directory.
 * Inputs/Outputs: Accepts zip path + output directory and resolves with extracted file paths.
 * Edge cases: Zip Slip attempts, zip bombs, blocked executable extensions, and stream failures hard-fail extraction.
 */
export function extractZip(zipPath: string, outputDir: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extractedFiles: string[] = [];
    let entryCount = 0;
    let totalUncompressedSizeFromHeaders = 0;
    const archiveSizeGuardState: ArchiveSizeGuardState = {
      actualExtractedSizeBytes: 0,
      maxUncompressedSizeBytes: config.MAX_UNCOMPRESSED_SIZE,
    };
    let settled = false;

    const settleWithFailure = async (error: unknown, zipFile?: yauzl.ZipFile): Promise<void> => {
      if (settled) {
        return;
      }

      settled = true;

      if (zipFile) {
        try {
          zipFile.close();
        } catch (closeError) {
          logger.warn({ closeError }, "Zip archive close failed during extraction rollback");
        }
      }

      const cleanupSummary = await cleanupUploadArtifacts(outputDir);
      if (cleanupSummary.failures.length > 0) {
        logger.error(
          { failures: cleanupSummary.failures, outputDir },
          "Extraction cleanup encountered failures"
        );
      }

      reject(toExtractionError(error));
    };

    const settleWithSuccess = (): void => {
      if (settled) {
        return;
      }

      settled = true;
      resolve(extractedFiles);
    };

    yauzl.open(zipPath, { lazyEntries: true }, (openError, zipFile) => {
      if (openError || !zipFile) {
        void settleWithFailure(
          new UploadError("Failed to open zip archive", 400, "UPLOAD_EXTRACTION_FAILED", {
            cause: openError,
          })
        );
        return;
      }

      zipFile.readEntry();

      zipFile.on("entry", (entry: yauzl.Entry) => {
        if (settled) {
          return;
        }

        entryCount += 1;
        //audit Assumption: high entry counts indicate potential zip bomb payloads.
        //audit Failure risk: unbounded entry processing can exhaust CPU/disk resources.
        //audit Invariant: extraction never processes more than configured entry budget.
        //audit Handling: close archive and fail if entry count exceeds threshold.
        if (entryCount > config.MAX_ZIP_ENTRIES) {
          void settleWithFailure(
            new UploadError(
              "Zip bomb detected: too many entries",
              400,
              "UPLOAD_EXTRACTION_FAILED",
              { details: { entryCount, maxEntries: config.MAX_ZIP_ENTRIES } }
            ),
            zipFile
          );
          return;
        }

        totalUncompressedSizeFromHeaders += entry.uncompressedSize;
        //audit Assumption: cumulative uncompressed size is a valid bomb defense signal.
        //audit Failure risk: unchecked extraction can explode disk consumption.
        //audit Invariant: cumulative uncompressed bytes remain under configured ceiling.
        //audit Handling: abort extraction when threshold is crossed.
        if (totalUncompressedSizeFromHeaders > config.MAX_UNCOMPRESSED_SIZE) {
          void settleWithFailure(
            new UploadError(
              "Zip bomb detected: uncompressed size exceeds limit",
              400,
              "UPLOAD_EXTRACTION_FAILED",
              {
                details: {
                  totalUncompressedSizeFromHeaders,
                  maxUncompressedSize: config.MAX_UNCOMPRESSED_SIZE,
                },
              }
            ),
            zipFile
          );
          return;
        }

        //audit Assumption: directory entries do not require stream extraction.
        //audit Failure risk: attempting to stream directories would raise runtime errors.
        //audit Invariant: only file entries are opened as streams.
        //audit Handling: skip directories and continue iteration.
        if (isDirectoryEntry(entry.fileName)) {
          zipFile.readEntry();
          return;
        }

        //audit Assumption: executable payloads inside uploads are out-of-policy.
        //audit Failure risk: extracting executables increases malware exposure.
        //audit Invariant: blocked extensions are never written to disk.
        //audit Handling: skip blocked files while preserving extraction continuity.
        if (isBlockedFile(entry.fileName)) {
          logger.warn({ entryName: entry.fileName }, "Skipping blocked extension during extraction");
          zipFile.readEntry();
          return;
        }

        const destinationPath = path.join(outputDir, entry.fileName);

        try {
          //audit Assumption: destination path may contain traversal segments.
          //audit Failure risk: path traversal can overwrite files outside output directory.
          //audit Invariant: all extracted paths remain inside configured output directory.
          //audit Handling: guardZipSlip throws and stops extraction on violation.
          guardZipSlip(outputDir, destinationPath);
        } catch (pathError) {
          void settleWithFailure(pathError, zipFile);
          return;
        }

        zipFile.openReadStream(entry, (streamOpenError, readStream) => {
          if (streamOpenError || !readStream) {
            void settleWithFailure(
              new UploadError("Failed to read zip entry stream", 400, "UPLOAD_EXTRACTION_FAILED", {
                cause: streamOpenError,
                details: { entryName: entry.fileName },
              }),
              zipFile
            );
            return;
          }

          void fsPromises
            .mkdir(path.dirname(destinationPath), { recursive: true })
            .then(async () => {
              const writeStream = fs.createWriteStream(destinationPath);
              const archiveSizeGuardTransform =
                createArchiveSizeGuardTransform(archiveSizeGuardState);

              try {
                await streamPipeline(readStream, archiveSizeGuardTransform, writeStream);
              } catch (streamError) {
                if (streamError instanceof UploadError) {
                  throw streamError;
                }

                throw new UploadError(
                  "Failed to persist extracted entry",
                  400,
                  "UPLOAD_EXTRACTION_FAILED",
                  {
                    cause: streamError,
                    details: {
                      entryName: entry.fileName,
                      actualExtractedSizeBytes: archiveSizeGuardState.actualExtractedSizeBytes,
                      maxUncompressedSizeBytes: archiveSizeGuardState.maxUncompressedSizeBytes,
                    },
                  }
                );
              }

              extractedFiles.push(destinationPath);
              zipFile.readEntry();
            })
            .catch((entryError) => {
              void settleWithFailure(entryError, zipFile);
            });
        });
      });

      zipFile.on("error", (zipError: Error) => {
        void settleWithFailure(zipError, zipFile);
      });

      zipFile.on("end", settleWithSuccess);
    });
  });
}
