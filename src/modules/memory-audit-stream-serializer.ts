export interface MemoryAuditStreamConfig {
  streamChunks?: boolean;
  maxChunkSize?: number;
  useContinuationTokens?: boolean;
  logTrunc?: number;
}

import { splitResponse } from '../utils/response-splitter';
import { Response } from 'express';

export class MemoryAuditStreamSerializer {
  private config: MemoryAuditStreamConfig;

  constructor(config: MemoryAuditStreamConfig) {
    this.config = {
      streamChunks: true,
      maxChunkSize: 2048,
      useContinuationTokens: true,
      ...config
    };
  }

  serialize(data: any): string[] {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    if (!this.config.streamChunks) {
      return [text];
    }
    return splitResponse(text, {
      maxPayloadSize: this.config.maxChunkSize,
      enableContinuationFlag: this.config.useContinuationTokens
    });
  }

  stream(res: Response, data: any): void {
    const chunks = this.serialize(data);
    res.setHeader('Content-Type', 'application/json');
    for (const chunk of chunks) {
      res.write(chunk);
    }
    res.end();
  }
}

let instance: MemoryAuditStreamSerializer | null = null;

export function installMemoryAuditStreamSerializer(config: MemoryAuditStreamConfig): void {
  if (!instance) {
    instance = new MemoryAuditStreamSerializer(config);
    console.log('[MEMORY-AUDIT-STREAM] Module installed');
  }
}

export function getMemoryAuditStreamSerializer(): MemoryAuditStreamSerializer | null {
  return instance;
}
