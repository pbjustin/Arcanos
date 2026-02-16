import { createReadStream, promises as fs } from "fs";
import net from "net";
import { config } from "../config/index.js";
import { logger } from "../utils/logger.js";

export interface ClamavScanResult {
  status: "clean" | "infected" | "unavailable";
  signature?: string;
  rawResponse?: string;
}

/**
 * Purpose: Scan a file using ClamAV (`clamd`) over the INSTREAM protocol.
 * Inputs/Outputs: Accepts a file path and returns a structured malware scan result.
 * Edge cases: Scanner connectivity/timeouts return `unavailable` to let caller enforce policy.
 */
export async function scanFileWithClamav(filePath: string): Promise<ClamavScanResult> {
  //audit Assumption: file may be deleted between upload completion and scanner read.
  //audit Failure risk: scanning a missing file would create false clean results.
  //audit Invariant: a successful scan only runs against an existing readable file.
  //audit Handling: stat check ensures file accessibility before network scan.
  await fs.stat(filePath);

  try {
    const rawResponse = await streamFileToClamd(filePath);
    return parseClamavResponse(rawResponse);
  } catch (scanError) {
    //audit Assumption: scanner failures must be visible for fail-open/fail-closed decisions.
    //audit Failure risk: silent scan failures can bypass malware controls.
    //audit Invariant: scanner errors are logged with enough context for audit trails.
    //audit Handling: return `unavailable` and let upload pipeline enforce configured policy.
    logger.error({ filePath, error: scanError }, "ClamAV scan failed");
    return {
      status: "unavailable",
      rawResponse: scanError instanceof Error ? scanError.message : String(scanError),
    };
  }
}

/**
 * Purpose: Parse raw `clamd` response into a typed security outcome.
 * Inputs/Outputs: Accepts response text and returns clean/infected/unavailable classification.
 * Edge cases: Unexpected response formats default to `unavailable`.
 */
export function parseClamavResponse(rawResponse: string): ClamavScanResult {
  const normalizedResponse = rawResponse.trim();

  //audit Assumption: clamd clean responses end with "OK".
  //audit Failure risk: malformed parsing could mark malware as clean.
  //audit Invariant: only explicit "OK" is treated as clean.
  //audit Handling: unknown patterns fall back to `unavailable`.
  if (normalizedResponse.endsWith("OK")) {
    return { status: "clean", rawResponse: normalizedResponse };
  }

  const infectedMatch = normalizedResponse.match(/: (.+) FOUND$/);
  //audit Assumption: infected results match "<name>: <signature> FOUND".
  //audit Failure risk: signature parsing can fail on vendor format changes.
  //audit Invariant: infected files never return `clean`.
  //audit Handling: if parsing fails, classify as unavailable rather than clean.
  if (infectedMatch?.[1]) {
    return {
      status: "infected",
      signature: infectedMatch[1],
      rawResponse: normalizedResponse,
    };
  }

  return { status: "unavailable", rawResponse: normalizedResponse };
}

/**
 * Purpose: Send file bytes to `clamd` using the INSTREAM protocol and collect response text.
 * Inputs/Outputs: Accepts a file path and resolves with raw scanner response.
 * Edge cases: Socket timeout or stream errors reject with context-rich errors.
 */
async function streamFileToClamd(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({
      host: config.CLAMAV_HOST,
      port: config.CLAMAV_PORT,
    });
    const fileReadStream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
    let responseBuffer = "";
    let completed = false;

    const settleWithError = (error: unknown): void => {
      if (completed) {
        return;
      }

      completed = true;
      fileReadStream.destroy();
      socket.destroy();
      reject(error);
    };

    const settleWithSuccess = (): void => {
      if (completed) {
        return;
      }

      completed = true;
      fileReadStream.destroy();
      socket.end();
      resolve(responseBuffer.trim());
    };

    socket.setTimeout(config.CLAMAV_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write("zINSTREAM\0");

      fileReadStream.on("data", (chunk: string | Buffer) => {
        const chunkBuffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
        const chunkLength = Buffer.alloc(4);
        chunkLength.writeUInt32BE(chunkBuffer.length, 0);
        const packet = Buffer.concat([chunkLength, chunkBuffer]);

        const canContinueWriting = socket.write(packet);
        //audit Assumption: socket backpressure can occur on large uploads.
        //audit Failure risk: ignoring backpressure can inflate memory usage.
        //audit Invariant: file stream pauses while socket buffer is saturated.
        //audit Handling: pause/resume stream around socket `drain`.
        if (!canContinueWriting) {
          fileReadStream.pause();
          socket.once("drain", () => fileReadStream.resume());
        }
      });

      fileReadStream.on("end", () => {
        const terminalChunk = Buffer.alloc(4);
        socket.write(terminalChunk);
      });

      fileReadStream.on("error", settleWithError);
    });

    socket.on("data", (chunk: string | Buffer) => {
      responseBuffer += Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
    });

    socket.on("timeout", () => {
      settleWithError(new Error("ClamAV scan timed out"));
    });

    socket.on("error", settleWithError);

    socket.on("end", settleWithSuccess);

    socket.on("close", (hadError: boolean) => {
      //audit Assumption: some clamd versions close after response without explicit `end` ordering.
      //audit Failure risk: losing final response chunk on abrupt socket close.
      //audit Invariant: non-error close with data is treated as scan completion.
      //audit Handling: synthesize success if buffer exists and no error was reported.
      if (!completed && !hadError && responseBuffer.length > 0) {
        settleWithSuccess();
      }
    });
  });
}
