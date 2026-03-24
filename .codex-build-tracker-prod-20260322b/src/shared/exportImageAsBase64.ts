import { Buffer } from 'node:buffer';

/**
 * Safely export binary image data as a Base64 string that is
 * compatible with the OpenAI SDK. The encoded string is padded,
 * chunked to avoid truncation in long responses, and terminated
 * with an explicit end-of-image marker.
 *
 * @param imageBytes - Raw image bytes
 * @param chunkSize - Size of each chunk in the output (default: 4096)
 * @returns Newline-separated Base64 chunks ending with `===EOI===`
 */
export function exportImageAsBase64(imageBytes: Buffer | Uint8Array, chunkSize = 4096): string {
  // Ensure we are working with a Buffer
  const buffer = Buffer.isBuffer(imageBytes) ? imageBytes : Buffer.from(imageBytes);

  let encoded = buffer.toString('base64');

  // Ensure proper padding (OpenAI requires correctly padded Base64)
  const remainder = encoded.length % 4;
  if (remainder) {
    encoded += '='.repeat(4 - remainder);
  }

  const chunks: string[] = [];
  for (let i = 0; i < encoded.length; i += chunkSize) {
    chunks.push(encoded.slice(i, i + chunkSize));
  }

  // Append explicit end-of-image marker
  chunks.push('===EOI===');

  return chunks.join('\n');
}

export default exportImageAsBase64;
