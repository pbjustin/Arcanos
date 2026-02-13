import yauzl from "yauzl";
import { promises as fsPromises } from "fs";
import fs from "fs";
import path from "path";
import { guardZipSlip } from "../utils/zipSlipGuard.js";
import { streamPipeline } from "../utils/streamPipeline.js";
import { config } from "../config/index.js";
import { UploadError } from "../types/upload.js";

export function extractZip(
  zipPath: string,
  outputDir: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extracted: string[] = [];
    let entryCount = 0;
    let totalUncompressedSize = 0;

    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);

      zip.readEntry();

      zip.on("entry", (entry: yauzl.Entry) => {
        entryCount++;
        if (entryCount > config.MAX_ZIP_ENTRIES) {
          zip.close();
          return reject(new UploadError("Zip bomb detected: too many entries", 400));
        }

        totalUncompressedSize += entry.uncompressedSize;
        if (totalUncompressedSize > config.MAX_UNCOMPRESSED_SIZE) {
          zip.close();
          return reject(new UploadError("Zip bomb detected: uncompressed size exceeds limit", 400));
        }

        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }

        const destPath = path.join(outputDir, entry.fileName);
        guardZipSlip(outputDir, destPath);

        zip.openReadStream(entry, async (err, readStream) => {
          if (err || !readStream) return reject(err);

          await fsPromises.mkdir(path.dirname(destPath), { recursive: true });
          const writeStream = fs.createWriteStream(destPath);

          try {
            await streamPipeline(readStream, writeStream);
            extracted.push(destPath);
            zip.readEntry();
          } catch (e) {
            reject(e);
          }
        });
      });

      zip.on("end", () => resolve(extracted));
      zip.on("error", reject);
    });
  });
}
