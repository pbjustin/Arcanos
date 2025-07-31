import { splitResponse } from '../utils/response-splitter';

export interface PagedOutputConfig {
  maxPayloadSize?: number;
  chunkPrefix?: string;
  enableContinuationFlag?: boolean;
  syncContextMemory?: boolean;
}

export class PagedOutputHandler {
  private config: PagedOutputConfig;

  constructor(config: PagedOutputConfig) {
    this.config = config;
  }

  paginate(text: string): string[] {
    return splitResponse(text, {
      maxPayloadSize: this.config.maxPayloadSize,
      chunkPrefix: this.config.chunkPrefix,
      enableContinuationFlag: this.config.enableContinuationFlag,
    });
  }
}

let handlerInstance: PagedOutputHandler | null = null;

export function installPagedOutputHandler(config: PagedOutputConfig): void {
  if (!handlerInstance) {
    handlerInstance = new PagedOutputHandler(config);
    console.log('[PAGED-OUTPUT] Module installed');
  }
}

export function getPagedOutputHandler(): PagedOutputHandler | null {
  return handlerInstance;
}
