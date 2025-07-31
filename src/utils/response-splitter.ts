export interface SplitOptions {
  maxPayloadSize?: number;
  chunkPrefix?: string;
  enableContinuationFlag?: boolean;
}

export function splitResponse(text: string, options: SplitOptions = {}): string[] {
  const {
    maxPayloadSize = 2048,
    chunkPrefix = '',
    enableContinuationFlag = false,
  } = options;

  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxPayloadSize) {
    let chunk = text.slice(i, i + maxPayloadSize);
    if (chunkPrefix) {
      chunk = `${chunkPrefix} ${chunk}`;
    }
    if (enableContinuationFlag && i + maxPayloadSize < text.length) {
      chunk += '...';
    }
    chunks.push(chunk);
  }
  return chunks;
}
