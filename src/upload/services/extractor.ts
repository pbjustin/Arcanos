import yauzl from "yauzl";
import { promises as fsPromises } from "fs";
import fs from "fs";
import path from "path";
import { guardZipSlip } from "../utils/zipSlipGuard.js";
import { streamPipeline } from "../utils/streamPipeline.js";
import { config } from "../config/index.js";
import { UploadError } from "../types/upload.js";
import { logger } from "../utils/logger.js";

/** File extensions we skip during extraction (executables, binaries). */
const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".dll", ".bat", ".cmd", ".com", ".scr", ".msi", ".ps1",
]);

function isBlockedFile(fileName: string): boolean {
  return BLOCKED_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

/**
 * Remove a directory tree silently — used for cleanup on failure.
 */
async function cleanupDir(dir: string): Promise<void> {
  try {
    await fsPromises.rm(dir, { recursive: true, force: true });
  } catch {
    logger.warn({ dir }, "Failed to cleanup directory after extraction error");
  }
}

export function extractZip(
  zipPath: string,
  outputDir: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extracted: string[] = [];
    let entryCount = 0;
    let totalUncompressedSize = 0;
    let settled = false;

    function fail(err: unknown) {
      if (settled) return;
      settled = true;
      cleanupDir(outputDir).finally(() => reject(err));
    }

    function succeed(files: string[]) {
      if (settled) return;
      settled = true;
      resolve(files);
    }

    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return fail(err ?? new UploadError("Failed to open zip", 400));

      zip.readEntry();

      zip.on("entry", (entry: yauzl.Entry) => {
        if (settled) return;

        entryCount++;
        if (entryCount > config.MAX_ZIP_ENTRIES) {
          zip.close();
          return fail(new UploadError("Zip bomb detected: too many entries", 400));
        }

        totalUncompressedSize += entry.uncompressedSize;
        if (totalUncompressedSize > config.MAX_UNCOMPRESSED_SIZE) {
          zip.close();
          return fail(new UploadError("Zip bomb detected: uncompressed size exceeds limit", 400));
        }

        // Skip directories
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }

        // Skip blocked file types
        if (isBlockedFile(entry.fileName)) {
          logger.info({ file: entry.fileName }, "Skipping blocked file extension");
          zip.readEntry();
          return;
        }

        const destPath = path.join(outputDir, entry.fileName);

        try {
          guardZipSlip(outputDir, destPath);
        } catch (slipErr) {
          zip.close();
          return fail(slipErr);
        }

        zip.openReadStream(entry, (streamErr, readStream) => {
          if (streamErr || !readStream) return fail(streamErr);

          fsPromises
            .mkdir(path.dirname(destPath), { recursive: true })
            .then(() => {
              const writeStream = fs.createWriteStream(destPath);
              return streamPipeline(readStream, writeStream);
            })
            .then(() => {
              extracted.push(destPath);
              zip.readEntry();
            })
            .catch(fail);
        });
      });

      zip.on("end", () => succeed(extracted));
      zip.on("error", fail);
    });
  });
}
