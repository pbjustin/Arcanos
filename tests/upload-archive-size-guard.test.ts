import { describe, expect, it } from '@jest/globals';
import { Readable, Writable } from 'stream';
import { createArchiveSizeGuardTransform } from '../src/upload/utils/archiveSizeGuard';
import { streamPipeline } from '../src/upload/utils/streamPipeline';
import { UploadError } from '../src/upload/types/upload';

function createSinkWritable(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
}

describe('createArchiveSizeGuardTransform', () => {
  it('allows stream data when cumulative bytes are within limit', async () => {
    const state = {
      actualExtractedSizeBytes: 0,
      maxUncompressedSizeBytes: 8,
    };

    await expect(
      streamPipeline(
        Readable.from([Buffer.from('abc'), Buffer.from('def')]),
        createArchiveSizeGuardTransform(state),
        createSinkWritable(),
      ),
    ).resolves.toBeUndefined();

    expect(state.actualExtractedSizeBytes).toBe(6);
  });

  it('rejects stream when cumulative bytes exceed limit', async () => {
    const state = {
      actualExtractedSizeBytes: 0,
      maxUncompressedSizeBytes: 5,
    };

    const rejectionPromise = streamPipeline(
      Readable.from([Buffer.from('abc'), Buffer.from('def')]),
      createArchiveSizeGuardTransform(state),
      createSinkWritable(),
    );

    await expect(rejectionPromise).rejects.toBeInstanceOf(UploadError);
    await expect(rejectionPromise).rejects.toMatchObject({
      message: 'Zip bomb detected: actual extracted size exceeds limit',
      code: 'UPLOAD_EXTRACTION_FAILED',
    });
  });
});
