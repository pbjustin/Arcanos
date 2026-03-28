import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { resolveErrorMessage } from '@core/lib/errors/index.js';

type PathProvider = () => string;

async function ensureParentDirectory(filePath: string): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

export class AsyncSnapshotFileWriter {
  private pendingContents: string | null = null;

  private flushPromise: Promise<void> | null = null;

  private flushFailed = false;

  constructor(
    private readonly pathProvider: PathProvider,
    private readonly label: string,
  ) {}

  enqueue(contents: string): void {
    this.pendingContents = contents;
    this.flushFailed = false;
    this.ensureFlushLoop();
  }

  async flush(): Promise<void> {
    this.ensureFlushLoop();
    await this.flushPromise;
  }

  reset(): void {
    this.pendingContents = null;
    this.flushFailed = false;
  }

  private ensureFlushLoop(): void {
    if (!this.flushPromise) {
      this.flushPromise = this.flushPendingContents();
    }
  }

  private async flushPendingContents(): Promise<void> {
    let attemptedContents: string | null = null;

    try {
      while (typeof this.pendingContents === 'string') {
        const nextContents = this.pendingContents;
        attemptedContents = nextContents;
        this.pendingContents = null;
        const filePath = this.pathProvider();
        await ensureParentDirectory(filePath);
        await fsp.writeFile(filePath, nextContents, 'utf8');
        attemptedContents = null;
      }
    } catch (error) {
      this.flushFailed = true;
      if (typeof this.pendingContents !== 'string' && typeof attemptedContents === 'string') {
        this.pendingContents = attemptedContents;
      }
      console.error(`[${this.label}] failed to write snapshot`, resolveErrorMessage(error));
    } finally {
      this.flushPromise = null;
      if (typeof this.pendingContents === 'string' && !this.flushFailed) {
        this.ensureFlushLoop();
      }
    }
  }
}
