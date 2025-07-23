import express from 'express';
import * as http from 'http';
import { databaseService } from './database';
import { isTrue } from '../utils/env';

export class ServerService {
  private server: http.Server | null = null;

  async start(app: express.Application, port: number): Promise<void> {
    if (this.server) {
      throw new Error('Server already started');
    }
    this.server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      this.server!.listen(port, resolve);
      this.server!.on('error', reject);
    });
    console.log(`[SERVER] Running on port ${port}`);
  }

  async shutdown(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server!.close(err => (err ? reject(err) : resolve()));
    });
    console.log('✅ Server closed successfully');
    await databaseService.close();
    console.log('✅ Database pool closed');
    this.server = null;
  }

  setupSignalHandlers(): void {
    const handler = async (signal: string) => {
      console.log(`[SIGNAL] ${signal} received.`);
      if (isTrue(process.env.RUN_WORKERS)) {
        console.log('[SIGNAL] RUN_WORKERS=true - gracefully shutting down...');
        try {
          await this.shutdown();
          process.exit(0);
        } catch (error) {
          console.error('❌ Error during shutdown:', error);
          process.exit(1);
        }
      } else {
        console.log('[SIGNAL] RUN_WORKERS not true - ignoring signal to keep server alive');
      }
    };
    process.on('SIGTERM', () => handler('SIGTERM'));
    process.on('SIGINT', () => handler('SIGINT'));
  }
}

export const serverService = new ServerService();
