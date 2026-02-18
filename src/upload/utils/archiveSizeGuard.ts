import { Transform, TransformCallback } from "stream";
import { UploadError } from "../types/upload.js";

export interface ArchiveSizeGuardState {
  actualExtractedSizeBytes: number;
  maxUncompressedSizeBytes: number;
}

function getChunkByteLength(chunk: unknown): number {
  if (Buffer.isBuffer(chunk)) {
    return chunk.length;
  }

  if (typeof chunk === "string") {
    return Buffer.byteLength(chunk);
  }

  if (chunk instanceof Uint8Array) {
    return chunk.byteLength;
  }

  return Buffer.byteLength(String(chunk));
}

/**
 * Purpose: Create a transform stream that enforces cumulative extracted-byte limits.
 * Inputs/Outputs: Accepts mutable archive size state and returns a Transform stream.
 * Edge cases: Throws UploadError as soon as streamed bytes exceed the configured limit.
 */
export function createArchiveSizeGuardTransform(state: ArchiveSizeGuardState): Transform {
  return new Transform({
    transform(chunk: unknown, _encoding: BufferEncoding, callback: TransformCallback): void {
      const chunkSizeBytes = getChunkByteLength(chunk);
      state.actualExtractedSizeBytes += chunkSizeBytes;

      //audit Assumption: zip entry headers can be forged and cannot be trusted as sole size controls.
      //audit Failure risk: zip bomb payload can exhaust disk by streaming beyond declared limits.
      //audit Invariant: cumulative extracted bytes never exceed maxUncompressedSizeBytes.
      //audit Handling: fail-fast with UploadError when streamed bytes cross configured ceiling.
      if (state.actualExtractedSizeBytes > state.maxUncompressedSizeBytes) {
        callback(
          new UploadError(
            "Zip bomb detected: actual extracted size exceeds limit",
            400,
            "UPLOAD_EXTRACTION_FAILED",
            {
              details: {
                actualExtractedSizeBytes: state.actualExtractedSizeBytes,
                maxUncompressedSizeBytes: state.maxUncompressedSizeBytes,
              },
            }
          )
        );
        return;
      }

      callback(null, chunk as Buffer);
    },
  });
}

