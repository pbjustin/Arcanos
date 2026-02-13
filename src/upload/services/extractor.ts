import yauzl from "yauzl";
import fs from "fs";
import path from "path";
import { guardZipSlip } from "../utils/zipSlipGuard.js";
import { streamPipeline } from "../utils/streamPipeline.js";

export function extractZip(
  zipPath: string,
  outputDir: string
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const extracted: string[] = [];

    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err);

      zip.readEntry();

      zip.on("entry", (entry: yauzl.Entry) => {
        if (/\/$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }

        const destPath = path.join(outputDir, entry.fileName);
        guardZipSlip(outputDir, destPath);

        zip.openReadStream(entry, async (err, readStream) => {
          if (err || !readStream) return reject(err);

          fs.mkdirSync(path.dirname(destPath), { recursive: true });
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
